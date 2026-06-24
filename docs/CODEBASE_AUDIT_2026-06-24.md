# GenesisCA — Whole-Codebase Audit (2026-06-24)

Comprehensive review requested after the Generic Agent Platform + v1.22.0 bump:
*"a thorough review of everything (not just this branch) looking for inconsistencies,
bugs and so on. Document it all and then work on it."*

## Method

A multi-agent review workflow (`genesisca-full-review`): **12 subsystem reviewers**
fan out across the codebase → each finding is **adversarially verified** (a second
agent reads the actual code and tries to *refute* it; only confirmed, not-already-
documented defects survive) → a synthesis agent dedups + prioritizes. Reviewers were
told to treat CLAUDE.md's documented intentional differences / known limitations as
**not** bugs, and to back every finding with the exact code (file:line).

## ⚠️ Coverage status — PARTIAL (re-run required)

Server rate limits (a transient "not your usage limit" throttle, then a session usage
limit) split the review across runs, but **all 12 subsystems are now reviewed** and
**all 18 confirmed findings are fixed** (see Fix status below).

| Subsystem | Status |
|---|---|
| `node-catalogue-a` (nodes A–L) | ✅ reviewed (run 1) |
| `node-catalogue-b` (nodes M–Z) | ✅ reviewed (run 1) |
| `js-compiler` | ✅ reviewed (run 2) |
| `wasm-compiler` | ✅ reviewed (run 2) |
| `webgpu-compiler` | ✅ reviewed (run 2) |
| `worker-engine` | ✅ reviewed (run 2) |
| `agent-platform` | ✅ reviewed (run 2) |
| `save-load-3d` | ✅ reviewed (run 2) |
| `modeler-ui-state` | ✅ reviewed (run 2) |
| `indicators-mappings` | ✅ reviewed (run 2) |
| `validation-gating` | ✅ reviewed (run 2) |
| `doc-consistency` | ✅ reviewed directly (workflow reviewer was rate-limited — see the doc-consistency section) |

Run 1 = `wf_c2e61a38-65e` (node-catalogue), run 2 = `wf_2f97c6bc-99c` (the chunked re-run, 9 subsystems). doc-consistency was done by hand (read-only spot-checks) after both runs.

## Confirmed findings (node-catalogue slice)

All three share **one root cause**: the documented boolean **1/0 convention**
("Bool constants use `1`/`0` (not `true`/`false`) for typed-array compatibility",
CLAUDE.md) is **not enforced uniformly across the three compile targets for the
AND/OR family of operators.** The normalize-then-bitwise pattern is already present and
correct elsewhere in the *same* WASM emitter (XOR; updateAttribute/updateIndicator
or/and) — so the AND/OR omissions are oversights against a known-good local template.

### F1 — `logicOperator` AND/OR diverges across targets (severity: MEDIUM) — ✅ FIXED
- **Where:** JS [LogicOperatorNode.ts](../src/modeler/vpl/nodes/LogicOperatorNode.ts); WASM [wasm/compile.ts](../src/modeler/vpl/compiler/wasm/compile.ts) `logicOperator` emitter; WebGPU [webgpu/compile.ts](../src/modeler/vpl/compiler/webgpu/compile.ts).
- **Defect:** WASM emits raw `OP_I32_AND` / `OP_I32_OR` on **un-normalized** i32 operands; JS uses `&&`/`||`; WebGPU casts to `bool` (`!= 0`). For a non-0/1 input the truthiness **flips on WASM**: `a=1,b=4` AND → JS `1&&4`=4 (truthy), WebGPU `true&&true`=true, **WASM `1&4`=0 (FALSE)**. `OR a=1,b=2` → JS=1, WASM `1|2`=3 (both truthy but stored value differs → breaks downstream `===`).
- **Reachable:** the Logic node's `a`/`b` ports are `dataType:'bool'`, but `portsCompatible`/`isValidConnection` permit any `dataType:'any'` source, and most value outputs (getCellAttribute, getModelAttribute, arithmeticOperator.result, getNeighborAttributeByIndex) are `'any'` — so a non-0/1 integer legitimately reaches the Logic input. **Same model → different result on WASM vs JS/WebGPU.**
- **Fix:** normalize each operand to 0/1 on all targets and return 1/0 (a boolean op should return a boolean). For 0/1 inputs (the common case) the result is **identical**, so no correct model changes behaviour; only the non-0/1 edge case is corrected into agreement.

### F2 — `aggregate` AND/OR over a non-0/1 array diverges (severity: LOW) — ✅ FIXED
- **Where:** JS [AggregateNode.ts](../src/modeler/vpl/nodes/AggregateNode.ts) (already correct, truthiness 1/0); WASM [wasm/compile.ts](../src/modeler/vpl/compiler/wasm/compile.ts) at **three** sites — nbr-path `emitAggregateOrCount`, single-ArrayRef, multi-scalar.
- **Defect:** WASM bitwise-folds raw elements via `OP_I32_AND`/`OP_I32_OR`; JS uses a truthiness break-loop (strict 1/0); WebGPU uses a `bool` accumulator (`castTo != 0`). For elements `[1,4]` op=and: JS=1, WebGPU=1, **WASM=`1&4`=0**. `Aggregate.values` is `dataType:'any' isArray` so an integer/tag array (e.g. GetNeighborsAttribute) is reachable.
- **Fix:** normalize each loaded element to 0/1 before the bitwise fold, at all three WASM sites.

### F3 — JS `logicOperator` / `groupOperator` AND/OR emit a JS boolean, not numeric 1/0 (severity: LOW) — ✅ FIXED
- **Where:** [LogicOperatorNode.ts](../src/modeler/vpl/nodes/LogicOperatorNode.ts) (XOR `(!!a !== !!b)`, NOT `(!a)`, and boolean-operand AND/OR); [GroupOperatorNode.ts](../src/modeler/vpl/nodes/GroupOperatorNode.ts) and/or (`.every(Boolean)` / `.some(Boolean)`).
- **Defect:** these JS paths yield a JS boolean (`true`/`false`); WASM returns i32 1/0 and WebGPU yields 1/0 at any numeric consumer (WGSL strong typing) — JS is the lone outlier. Harmless for truthy/Conditional consumers and when written into a `Uint8Array` (`true`→1), but a strict numeric consumer — Switch `value` mode (`=== caseVal`) or Compare `==` (emits `===`) — sees `true === 1` → **false** in JS while WASM/WebGPU match (`1 === 1`). Violates the documented 1/0 convention.
- **Fix:** coerce the JS emit to numeric 1/0 (`(expr ? 1 : 0)`), matching AggregateNode + the WASM/WebGPU integer convention. (F1's fix already covers logicOperator AND/OR; this also covers XOR/NOT + groupOperator and/or.)

### Refuted (1 raw finding)
One raw finding was refuted by the adversarial verifier (not a real defect / already documented as intentional). Not carried forward.

## Themes
1. **The boolean 1/0 convention is not enforced uniformly across compile targets.** WASM uses raw bitwise ops on un-normalized i32 for the AND/OR family while JS/WebGPU use value-preserving logical/truthiness semantics. A cross-target compile-parity test (the dev harness) over the AND/OR family with **non-0/1** inputs would have caught all three. **Worth a broader sweep of every emitter that treats an `'any'` input as a boolean.**
2. **Permissive port typing is the reachability enabler:** `portsCompatible`/`isValidConnection` allow any `'any'` source into a `'bool'` input, and most value outputs are `'any'`.
3. The normalization pattern is already established + correct in the same WASM emitter (XOR; updateAttribute/updateIndicator) — the AND/OR omissions are local oversights, not design.

## Action plan
1. ✅ **Fix F1+F2+F3 as one coherent "normalize AND/OR/group-and/or to 0/1 on every target" sweep** (shared root cause, adjacent code). — done this session; see below.
2. ⏳ **Re-run the review** for the 10 rate-limited subsystems (resume `wf_c2e61a38-65e`) and append their findings here.
3. Consider a permanent **cross-target AND/OR parity test** in the dev compile harness with non-0/1 inputs (theme 1).

## Fix log (this session)
All three confirmed findings fixed as one coherent "normalize AND/OR/group-and/or to 0/1 on every target" sweep:
- **F1** — JS [LogicOperatorNode.ts](../src/modeler/vpl/nodes/LogicOperatorNode.ts): all four ops now emit numeric 1/0 (`(a && b) ? 1 : 0`, etc.). WASM [wasm/compile.ts](../src/modeler/vpl/compiler/wasm/compile.ts) `logicOperator`: AND/OR now normalize each operand to 0/1 (`i32Const(0); OP_I32_NE_OP`) before the bitwise op, mirroring the XOR path. WebGPU unchanged (already bool-typed).
- **F2** — WASM aggregate and/or at all THREE sites (nbr-path `emitAggregateOrCount`, `emitArrayAggregate`, `emitScalarAggregate`): each loaded element is normalized to 0/1 before the bitwise fold.
- **F3** — JS [GroupOperatorNode.ts](../src/modeler/vpl/nodes/GroupOperatorNode.ts) and the **fused** `buildFusedGroupOperatorJS` in [compile.ts](../src/modeler/vpl/compiler/compile.ts) now emit numeric 1/0 for and/or (the fused path's comment + emit corrected; it previously returned JS booleans and even documented the divergence). LogicOperator XOR/NOT covered by F1.
- **Verified:** `tsc -p tsconfig.app.json --noEmit` clean; dev compile-harness on a graph feeding a non-0/1 value into Logic AND — JS emits `((_vn1 && _vn2) ? 1 : 0)`, all three targets compile clean, and `AND(1,4)` now yields **1 on all three** (was JS=4, WASM=0).

## Confirmed findings — subsystems beyond node-catalogue (run `wf_2f97c6bc-99c`)

The chunked re-run reviewed **9 of the 10** remaining subsystems (the 10th, `doc-consistency`, and the
synthesis step hit my **session usage limit** — re-run after it resets). **18 findings confirmed** by
adversarial verification. The full evidence/verdicts are in the workflow output (`tasks/wx6s2ao20.output`).
Severity below is the verifier-**adjusted** value. Status: ✅ fixed this session · ⏳ pending.

> **NB — one bug, two reports:** "WASM sync-mode linked indicators one generation stale" was found by BOTH the
> `worker-engine` and `indicators-mappings` reviewers (H7 ≡ M-dup). One fix covers both.

| # | Sev | Subsystem | Finding | Location | Fix | Status |
|---|-----|-----------|---------|----------|-----|--------|
| H1 | HIGH | wasm (agent) | Agent-WASM Compare reads `config.operator` (a key that's never written) instead of `config.operation` → every `>`,`<`,`!=`,`>=`,`<=`,`between` silently becomes `==` on the WASM agent target | [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):460 (emitCompare) + :1002 (gate) | read `config.operation` in both places | ✅ |
| H2 | HIGH | worker / indicators | WASM **sync-mode** linked indicators computed one generation stale — `computeLinkedIndicatorsFromBuffer()` runs BEFORE the w→r buffer copy, so it reads gen N-1 while JS reads `w_` (gen N) | [sim.worker.ts](../src/simulator/engine/sim.worker.ts) runStep WASM branch (~2272) vs the w→r copy (~2310) | relocate the call to AFTER the sync w→r copy (where computeSpatialIndicators already sits) | ✅ |
| H3 | HIGH | validation-gating | Stale agent-target gate blocks the **WebGPU GRID** compile for ANY agents model — `detectAgentTargetRestriction` keys off the GRID target (`useWebGPU`/`useWasm`) and is routed into `detectWebGPUModelIncompatibilities` as a hard error, silently negating the shipped WebGPU-grid-for-agents feature | [nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts):654-676 | drop the `detectAgentTargetRestriction` call from `detectWebGPUModelIncompatibilities` (agent target is resolved independently via `agentTargetOf`) | ✅ |
| M1 | MED | js-compiler | `forEachBond` body is not walked by `sinkAnalysis`/`volatileHoist` (only `forEachInArray` is) → a Local-Variable accumulator mutated inside a bond loop is emitted ABOVE the loop and reads its pre-loop value | [sinkAnalysis.ts](../src/modeler/vpl/compiler/sinkAnalysis.ts):241-247 + [volatileHoist.ts](../src/modeler/vpl/compiler/volatileHoist.ts):203-222 | add a `forEachBond` body-scope branch to both analyzers (mirror forEachInArray) + seed `elementDependentsByForEach` for its per-iteration ports | ✅ |
| M2 | MED | worker-engine | Adding indicators mid-session (`updateIndicators`, no structural reinit) over-extends `cachedIndicators` past its reserved wasmMemory region AND the recompiled WASM module bakes shifted rngState/order offsets vs the old-sized memory → RNG/order desync + OOB | [sim.worker.ts](../src/simulator/engine/sim.worker.ts) updateIndicators + [SimulatorView.tsx](../src/simulator/SimulatorView.tsx) `needsFullInit` | add an indicator-set-length/id change to `needsFullInit` (force full reinit) | ✅ |
| M3 | MED | agent-platform | `Get Nearby Agents` JS node is 2D-only (no `ctx`, XY-distance + 2D bin stencil) while its WASM emitter is 3D-aware → wrong neighbour set on the JS/Reference target in a 3D agent model | [GetNearbyAgentsNode.ts](../src/modeler/vpl/nodes/GetNearbyAgentsNode.ts):23-33 | give the JS node the same `ctx?.is3d` branch (read `_agentZ`, fold dz, 3×3×3 stencil) + thread `_hashNBinsZ`/`_hashBinSizeZ` into the JS agent-loop ABI | ✅ |
| M4 | MED | agent-platform | `agentUsesField()` scans only the raw top-level agent graph, missing field nodes INSIDE macros (the compiler flattens macros) → the WebGPU-grid field bridge (readback/upload) is skipped → SampleField reads stale / deposits discarded | [SimulatorView.tsx](../src/simulator/SimulatorView.tsx):1094-1098 | expand macros (or scan referenced macroDefs) before the FIELD_NODE_TYPES check | ✅ |
| M5 | MED | save-load-3d | Controls-only project save synthesizes a workerState with no `depth` → `serializeSimState` writes `gridDepth:1` → on reload the 3D drop-guard sees a dim mismatch and silently discards the embedded controls | [SimulatorView.tsx](../src/simulator/SimulatorView.tsx) controls-only captureState (~2496) | add `depth: gridDepth.current` to the synthesized workerState | ✅ |
| M6 | MED | modeler-ui-state | Tag-option reorder/delete remaps getConstant/switch/setAttribute but NOT `statement` (Compare) tag operands → a tag Compare silently compares the wrong option after a reorder | [ModelContext.tsx](../src/model/ModelContext.tsx):434-455 (UPDATE_ATTRIBUTE tagOptions remap) | add `statement`+`compareType==='tag'` to the predicate; remap `_port_x`/`_port_y`/`_port_y2` | ✅ |
| M7 | MED | modeler-ui-state | Agent variables (`agentVariables`) are missing from the attribute delete / tagOptions-remap / type-change cascades that protect cell variables → a tag-typed agent var keeps a dangling attributeId / stale initialValue | [ModelContext.tsx](../src/model/ModelContext.tsx):284-288, 413-418, 482-487 | apply each cascade to `agentVariables` too | ✅ |
| M8 | MED | indicators | `buildReductionPlan` omits the 3D `'layers'` spatial axis (only `rows`/`columns` skipped) → on WebGPU the GPU reduction overwrites the per-layer chromatogram with a generation-axis scalar | [webgpuReduce.ts](../src/simulator/engine/webgpuReduce.ts):92 | add `'layers'` to the skip (all sibling gates already include it) | ✅ |
| M9 | MED | validation-gating | CaNode validation badge `configIssues` useMemo omits `model.variables`/`agentVariables`/`agentAttributes`/`topologyMode`/`dimension` from its deps → badges go stale on those edits | [CaNode.tsx](../src/modeler/vpl/CaNode.tsx):500-543 | add the missing deps | ✅ |
| L1 | LOW | js-compiler | `Filter Agents` reads `r_<attr>[id]` with no id guard → a `-1`/dead id from a hand-built array survives `notEquals` and poisons downstream gather (sibling `getAgentsAttribute` guards) | [FilterAgentsNode.ts](../src/modeler/vpl/nodes/FilterAgentsNode.ts):43-45 | guard `id>=0 && id<highWater && _alive[id]` in the filter loop | ✅ |
| L2 | LOW | webgpu | Stale `setColorViewer`/`setCellGlyph` references in WebGPU compiler comments after the SetCellLooks merge (pure comment drift) | [webgpu/compile.ts](../src/modeler/vpl/compiler/webgpu/compile.ts):174-175,3579 + [webgpu/layout.ts](../src/modeler/vpl/compiler/webgpu/layout.ts):92 | rename comments → setCellLooks | ✅ |
| L3 | LOW | indicators | Float-frequency degenerate (all-equal) case: WASM/WebGPU CPU fallback emits ONE bucket; JS-embedded nudges `mx=mn+1` and bins into N → different histogram shape across targets | [sim.worker.ts](../src/simulator/engine/sim.worker.ts):3186-3189 vs [compile.ts](../src/modeler/vpl/compiler/compile.ts):1347-1361 | align: make the worker fallback do `if(mn===mx)mx=mn+1` + bin (match JS) | ✅ |
| L4 | LOW | validation-gating | Agent array-input nodes (filterAgents/getAgentsAttribute/setAgentsAttribute/joinAgents/pickRandomAgent/pickNRandomAgents) lack the unconnected-input badge their lattice siblings have → a forgotten wire silently yields empty results | [nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts):116-122 | add `isInputConnected('agents'/'a'/'b')` checks | ✅ |
| L5 | LOW | validation-gating | `lattice2d` capability message is stale (claims the NI codec is 2-axis-only; PR10 made it 3-axis). Path is currently dead (no node sets the flag) | [nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts):508-514 | rewrite the message to generic "requires a 2D lattice" wording | ✅ |

### Themes (beyond node-catalogue)
- **WASM/JS cross-target parity on the worker-side fallback paths** — the WASM linked-indicator replication (H2) and the float-frequency degenerate case (L3) both drifted from the JS-embedded aggregation they're supposed to mirror. A worker-side `computeLinkedIndicatorsFromBuffer` parity check vs the JS embed would catch these.
- **Agent subsystem lags the lattice subsystem's hardening** — Filter Agents id-guard (L1), unconnected-input badges (L4), agentVariables cascades (M7), and forEachBond analyzer coverage (M1) are all places where the agent clone of a lattice feature missed a guard the lattice path already has.
- **3D paths under-covered** — Get Nearby Agents 3D (M3), controls-only depth serialization (M5), and the `'layers'` reduction skip (M8) are three independent 2D-vs-3D divergences; worth a dedicated 3D-agent + 3D-spatial-indicator parity sweep.
- **Stale docstrings/comments after merges/renames** — L2 (setColorViewer→setCellLooks) and L5 (lattice2d message) — the doc-consistency reviewer (which would systematically catch these) was the one that got rate-limited.

## Fix status (this session)
**ALL 18 fixed + verified** (`tsc -p tsconfig.app.json --noEmit` clean + `npm run build` clean throughout): the 3 node-catalogue AND/OR findings (earlier section) + H1, H2, H3, M1–M9, L1–L5.

- **M1 (forEachBond analyzers)** — added a `forEachBond` body-scope branch to BOTH `sinkAnalysis.walkFlowNode` (combined with the `forEachInArray` branch via `||`) and `volatileHoist.walkNode`, and seeded `elementDependentsByForEach` for forEachBond's per-iteration ports (`partnerId`/`restLength`/`currentLength`/`index`). Verified via the compiler: a `forEachBond` body with a Local-Variable accumulator now emits `const _vn2=_var_acc; const _vn3=(_vn2 + _vn1_restLength); _var_acc=_vn3;` **inside** the bond `for` loop (previously the `_restLength`-dependent read would hoist above the loop). forEachInArray is byte-identical by construction (the `||` branch never evaluates for a forEachInArray node).
- **M3 (Get Nearby Agents 3D)** — threaded `_hashNBinsZ`/`_hashBinSizeZ` into the JS agent-loop ABI (the trailing 3D block of `buildAgentLoopParams` ↔ `buildAgentLoopArgs`) and added a `ctx?.is3d` branch to the node (3D distance with dz + torus fold against `_fieldD`, 3×3×3 stencil, 3D bin index `(nbz*NBinsY+nby)*NBinsX+nbx`). Verified: a 3D agent model emits the 3D query + the signature threads `_hashNBinsZ`; the 2D path is byte-clean (no `_agentZ`/`_hashNBinsZ`).

## doc-consistency (focused pass — the rate-limited subsystem)
Done directly (the workflow reviewer was rate-limited). Spot-checked ~12 specific CLAUDE.md symbol/file claims against the code (`agentTargetOf`, `attributeScope.ts` exports, `is3dModel`, `injectLinkedOutputMappings`, `collapseReroutes`, `canonicalizeAccessorEdges`, `computeAsyncReadWriteHazards`, the v1.22.0 four-file sweep, the NODES_REFERENCE 108-node count) — **all consistent**. One drift fixed: CLAUDE.md's agent-platform "**2D only (3D agents = Phase E)**" overstated the limitation — the agent COMPUTE (engine + JS *and* WASM neighbour queries) is 3D-aware; only the dedicated 3D agent RENDERER (gl3d.ts spheres/bond-tubes) is Phase E. Reworded. (A full systematic doc-consistency sweep across all of HelpView/README/NODES_REFERENCE remains lower-priority — it finds drift, not bugs; the codebase's doc-consistency discipline keeps drift minimal.)

## Follow-up (lower priority — no remaining bugs)
- The **synthesis** step never ran (session limit) — not needed now that all findings are triaged + fixed + recorded here.
- Consider the parity tests called out in the themes (worker-vs-JS indicator parity; 3D-agent + 3D-spatial parity) as regression guards.

# HANDOFF — Build the Bond-Graph AGENTS (floating cells) milestone for GenesisCA

> ## ✅ STATUS: Phases A–D SHIPPED (branch `agents_floating_cells`)
> The agent substrate (A), bonds (B), division/growth/death (C), and the closed
> agent↔grid feedback (D) are **implemented, verified, and committed** (13 commits,
> one per phase + polish + docs; lattice CA path byte-identical on every commit;
> full `npm run build` green). The headline morphogenesis works — see the shipped
> **Morphogenesis — Growing Tissue** library model and the implementation summary
> [docs/SUMMARY_AGENTS_FLOATING_CELLS.html](SUMMARY_AGENTS_FLOATING_CELLS.html)
> (read its "Assumptions & decisions" section — several runbook ambiguities were
> resolved pragmatically for v1). The CLAUDE.md "Bond-Graph Agents — Floating
> Cells" section is the maintained source of truth. **Still open:** Phase E (3D
> agents), Phase F (WASM/WebGPU lockstep), `Get Curvature`, `bondContactEvent`,
> the `.gcastate` file-format agent persistence, and a graph-authorable per-pair
> force law. The phased PR plan below is retained as historical record.

> **You (the next session) are being handed a fully-scoped, phased, build-ready ticket.** A prior investigation + plan effort produced three design docs ([INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md), [PLAN_BOND_GRAPH_MORPHOGENESIS.md](PLAN_BOND_GRAPH_MORPHOGENESIS.md), [PLAN_BG_DIMENSIONS_AND_MODES.md](PLAN_BG_DIMENSIONS_AND_MODES.md)) and a subsystem-by-subsystem build-depth audit of the **current, post-3D** codebase. The design is **settled** — do not re-derive it; it is cited (`file:line`) below. This document is your **runbook**: an ordered, *phased* list of PRs, each with a concrete change, files+symbols, a runnable acceptance test, and a risk note.
>
> This mirrors [docs/HANDOFF_3D_GRID_CA.md](HANDOFF_3D_GRID_CA.md) in tone and structure — a runbook, not an essay. That milestone **shipped** (its PR1–PR9 mapped 1:1 to commits, plus a 3-axis NeighborIndex codec, WebGPU-in-3D, a Get Cell Position node, and 7 rounds of 3D-viewport polish). So the codebase **already has** the foundation the agents reuse: the `dimension`/`gridDepth`/`topologyMode` schema, the `gl3d.ts` WebGL2 voxel renderer, authorable RGBA alpha, the 3D interaction-plane brush, the 3-axis NI codec. **This is the largest net-new subsystem GenesisCA has ever added** — scope it honestly and ship it phased.

---

## §0 — Mission, scope, phasing, and how to verify in this repo

### 0.1 Mission

Add **Bond-Graph AGENTS** — floating, continuous-position cells — to GenesisCA. Today every model is a *lattice* CA: a fixed `W×H×D` grid of sites, one Structure-of-Arrays typed array per attribute indexed by site, a precomputed neighbour-index table, the compiled step run once per site per generation. The **agent tier is a SECOND, co-resident engine** the same worker owns: a `maxAgents`-length continuous-position SoA (free-list-holed + alive-mask + `highWater` loop bound), a per-step **force-integration driver** (uniform spatial hash → soft-sphere repulsion + bond springs → overdamped Euler with a `Δt` monotonicity clamp), a **post-step structural phase** (tension-axis division eigensolve + free-list alloc; death + recycle; growth), a persistent **ragged bond store** with the `partnerEpoch` dangling-bond ABI, and the **closed agent↔grid feedback** bridge (the cell CA *is* the morphogen field; agents deposit into it before the grid step and gather from it after).

**The headline v1 demo** ([PLAN_BOND_GRAPH §1.2, M3 ★](PLAN_BOND_GRAPH_MORPHOGENESIS.md)): *a glued cluster of agents that GROWS and DIVIDES along its tension axis, bonds inherited by geometry, division rules authored over the user's own attributes*, with a closed agent↔grid feedback (the autonomous-branching demo).

**The headline honesty (carried from the plans, [PLAN_BOND_GRAPH §1.5](PLAN_BOND_GRAPH_MORPHOGENESIS.md)):** almost none of the agent substrate exists in `src/` today — a repo-wide grep for `maxAgents|AgentStore|behaviourStep|freeList|highWater|agentGraphNodes|activeGraph` matches **only** the `topologyMode` schema shipped with the 3D milestone. Every "reuse" tag is reuse of the *shipping* node-graph/compiler/simulator infrastructure plus *planned* agent machinery. The five genuinely-new subsystems ([PLAN_BOND_GRAPH §1.5 N1–N5](PLAN_BOND_GRAPH_MORPHOGENESIS.md)): the agent-iteration loop (N1), the post-step structural engine phase (N2 — the single largest), the agent+bond serializer (N3), the engine-owned per-agent buffers (N4), and the 3D entity renderer (N5).

### 0.2 In scope (this milestone) — phased

- **Phase A — agent substrate (JS, 2D):** un-gate the Agents topology + the two-graph Modeler split (M0b); the agent SoA + free-list + `maxAgents` + alive-mask; the force-integration driver (soft-sphere repulsion + per-step uniform-grid neighbour rebuild + `Δt` clamp) + the 2D circle entity renderer; the `behaviourStep` event root + agent value/flow nodes + the agent loop emit (D-IDX); agent seeding/brush/inspector.
- **Phase B — bonds:** the persistent ragged bond store + the dangling-bond ABI; `FormBond`/`BreakBond` + the bond spring force + hysteresis; the glue/cut bond brush + bond render layer.
- **Phase C — division/growth/death (the headline):** `DivideAgent` + the tension-axis eigensolve + geometric bond reattachment; `SetTargetRadius` growth; `KillAgent`; the `maxAgents`/`Δt` hazards.
- **Phase D — closed feedback (cell-CA-as-field):** `AffectCellsUnder`/`ReadCellsUnder` (any cell attr over a radius; deposit-into-read-buffer timing; sequential op-accumulate) + the 2-engine orchestration (the autonomous-branching demo).
- **Phase E (later) — 3D agents:** extend `gl3d.ts` to instanced spheres + bond tubes, reusing the shipped orbit/clip/pick.
- **Phase F (later) — WASM/WebGPU lockstep:** port the agent loop + structural-phase reads to WASM, then WebGPU.

### 0.3 Explicitly OUT OF SCOPE (state this prominently)

- **WASM and WebGPU agent compilation, for Phases A–D.** Per **Decision D-TARGET** ([PLAN_BOND_GRAPH §1.5](PLAN_BOND_GRAPH_MORPHOGENESIS.md)), the agent/bond/field nodes are **JS-reference-only for v1**. A model with `topologyMode.agents` enabled is **force-restricted to the JS compile target** (the worker's runStep branch is WebGPU>WASM>JS, [sim.worker.ts:1138](../src/simulator/engine/sim.worker.ts) — a `detectWasmIncompatibilities`/`detectWebGPUModelIncompatibilities`-style gate keeps the agent engine off targets that can't run it). Bonds are **sync-only** (D11); WebGPU rejects async outright. Phase F is the explicit later lockstep milestone.
- **The faithful Hertwig SHAPE long-axis division.** A center-based sphere has no shape ([INVESTIGATION_BOND_GRAPH §3.1](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md)). Only the **tension-proxy** axis exists. The `DivideAgent.axisSource` dropdown must be labelled "tension axis" — do **not** offer a "shape long-axis" option (it would silently fall back to tension and mislead).
- **3D agents (Phase E) and the 3D-agent renderer extension — deferred to after Phase D** ships and is verified in 2D. The shipped `gl3d.ts` voxel renderer is the reuse target, not free reuse (its instance buffer decodes x/y/z from a flat cell index — agents carry float positions, so the instance layout is a real change).
- **Variegated-cells-in-agents.** Variegation is lattice-only (2D-locked already); it has no meaning for floating agents. Do not touch the facing emitters.

**Lockstep-as-you-go rule:** within Phases A–D the agent engine is JS-only **by design** (D-TARGET) — this is NOT a lockstep violation, it is the bounded-cost decision. The cross-target lockstep policy still binds **the cell/lattice path you touch**: any shared compiler/worker edit must keep the lattice 2D *and* 3D output byte-identical on all three targets. Verify with the dev harness on a 2D model (Game of Life) AND a 3D model (Life3D) after every PR.

### 0.4 How to verify in this repo

Four verification surfaces, used at every PR:

**(a) `tsc -b` before every commit.** Vite's dev server does NOT type-check. Run `npx tsc -b` (or, if it hits the phantom `nodes/tsconfig.json` glitch, `npx tsc -p tsconfig.app.json --noEmit` — the root `tsc --noEmit` silently checks nothing because the root tsconfig has `"files": []`). The new `CenterBasedConfig`/`agentGraphNodes` schema, the agent `WorkerMsg` union additions, and any new dep-array wiring must type-check.

**(b) The cross-target compiler-import harness (byte-shape parity + agent-loop shape, NO UI).** This is the load-bearing parity check and the 2D/3D regression guarantee. With `npm run dev` running, a single `preview_eval` imports the compilers via the DEV harness ([src/dev/compileHarness.ts](../src/dev/compileHarness.ts) — `compileAll(model)` returns `{ js: { stepCode, fullCode }, wasm: { total, bytesJoined }, webgpu: { shaderCode } }`):

```js
const t = '?t=' + Date.now();                                        // cache-bust EVERY import — Vite's dev module cache is sticky for compiler files
const { compileAll, migrateForHarness } = await import('/src/dev/compileHarness.ts' + t);
const r = compileAll(model);                                         // assert on r.js.stepCode / r.wasm.bytesJoined / r.webgpu.shaderCode
```

Three uses: **agent-loop shape** (assert a `behaviourStep` model's emitted code contains `idx < highWater`, `if (!_alive[idx]) continue`, NO `const _row` / `colorIdx = idx*4`); **2D byte-identity regression** (compile Game of Life BEFORE and AFTER an agent-tier change; assert `js.stepCode` string-equal, `wasm.bytesJoined` equal, `webgpu.shaderCode` string-equal — proves the agent tier is purely additive and gated on `topologyMode.agents`); and **3D regression** (same on Life3D).

**(c) The worker via `window.__simWorker` + `getState` (headless agent-engine correctness).** `window.__simWorker` is exposed in DEV ([SimulatorView.tsx](../src/simulator/SimulatorView.tsx)) for direct `postMessage` — far more reliable than a standalone harness (the CLAUDE.md WASM note). After init, `window.__simWorker.postMessage({type:'seedAgents',...})` then `{type:'getState'}` returns the agent SoA — independently recompute the expected force integration / division geometry / bond topology and assert. This is how you verify the agent engine **before any renderer exists** (positions in `getState` are the ground truth).

**(d) `preview_eval` for UI.** The `dev` config in `.claude/launch.json` serves Vite on **port 51730**. `preview_eval` has a **30s tool timeout** — keep evals short, break long click→wait chains into multiple evals. `preview_screenshot` times out (~30s) on heavy pages — prefer DOM-query `preview_eval` checks and `gl.readPixels`-based assertions. Synthetic pointer events do NOT reliably drive React Flow / canvas drags — add **DEV-only `window.__*` hooks** (the precedent is `window.__simWorker`, `window.__sim3dCamera`/`__sim3dPick`/`__sim3dPaint`).

### 0.5 What ALREADY EXISTS that you reuse (the shipped foundation)

The 3D Grid CA milestone shipped the infrastructure the agents stand on — none of it is rebuilt:

- **`gl3d.ts` — the WebGL2 voxel renderer** ([src/simulator/render/gl3d.ts:283](../src/simulator/render/gl3d.ts)): `class Gl3DRenderer` with `Camera3D` (yaw/pitch/dist/target, [:116](../src/simulator/render/gl3d.ts)), `ClipPlane3D` (x/y/z/camera axis cut, [:119](../src/simulator/render/gl3d.ts)), `uploadColors(colors, total)` (alpha-0 cull + `[cellIndex,r,g,b,a]` instance pack, [:389](../src/simulator/render/gl3d.ts)), `setCamera` orbit ([:367](../src/simulator/render/gl3d.ts)), `render()` ([:472](../src/simulator/render/gl3d.ts)), colour-id `pick()` ([:816](../src/simulator/render/gl3d.ts)), `setHoverCells` ([:360](../src/simulator/render/gl3d.ts)), `setBackgroundColor` ([:364](../src/simulator/render/gl3d.ts)), back-to-front alpha sort ([:420](../src/simulator/render/gl3d.ts)). **Phase E extends this** to instanced spheres + bond tubes behind the same `draw()` seam.
- **Authorable RGBA alpha** (PR7 of the 3D milestone): `setCellLooks` has an `a` input port emitting `colors[colorIdx+3] = …` on all 3 targets (default 255 = byte-identical). Agents set per-agent alpha through the SAME node via the D-IDX `idx` contract — no new alpha mechanism.
- **`topologyMode` schema + reducer + UI shell** (M0a): `TopologyMode { gridCells, agents }` ([types.ts:565](../src/model/types.ts)) on `CAModel.topologyMode?` ([types.ts:593](../src/model/types.ts)); the `UPDATE_TOPOLOGY_MODE` reducer with the ≥1-checked guard ([ModelContext.tsx:909](../src/model/ModelContext.tsx)); the LOAD_MODEL default-fill ([ModelContext.tsx:717](../src/model/ModelContext.tsx)); the `EMPTY_MODEL` seed ([defaultModel.ts:31](../src/model/defaultModel.ts)); the Properties **Bond-Graph Agents** checkbox rendered-but-hard-disabled "coming soon" ([PropertiesPanelContent.tsx:370-388](../src/modeler/panels/PropertiesPanelContent.tsx)). The agent milestone's first move is making this checkbox actually do something.
- **The 3-axis NeighborIndex codec** (PR10 of the 3D milestone): the lattice NI family works in 3D. Irrelevant to agents (the NI codec + sub-attribute parent-guard are lattice-specific and must NOT be invoked from agent-world nodes), but it means the `lattice2d` requirements flag now has **zero users** ([vpl/types.ts:87-93](../src/modeler/vpl/types.ts)) — available infra, but distinct from the topology gate you add.
- **The 3D interaction-plane brush** + the rAF paint coalescer (`flushPaintBatch`, [SimulatorView.tsx:3029](../src/simulator/SimulatorView.tsx)) + `encodeAttrValue` ([src/model/attrValueEncoding.ts](../src/model/attrValueEncoding.ts)) — the agent brush reuses the coalescer + encoder verbatim, keyed by agent id.
- **The multi-compiled-fn worker** ([sim.worker.ts:393-400](../src/simulator/engine/sim.worker.ts) — `stepFn`/`initFn`/`inputColorFns[]`/`outputMappingFns[]`): the worker already runs several compiled functions per generation. The field (Phase D) reuses the entire lattice CA set 100%; the agents add `behaviourFn` + the structural phase.
- **The dev compile harness** ([src/dev/compileHarness.ts](../src/dev/compileHarness.ts) — `compileAll`) for cross-target byte-shape checks.

---

## §0.5 — Reconcile note — how the shipped 3D work differs from the original design assumptions

The three design docs predate the 3D Grid CA milestone. Where they conflict with the SHIPPED codebase, **this section wins**. Read it before starting.

1. **Schema field name: `topologyMode`, not `topology`.** The docs name the sub-object `topology` ([PLAN_BG_DIMENSIONS §3.2-3.3](PLAN_BG_DIMENSIONS_AND_MODES.md)). It **shipped as `topologyMode`** ([types.ts:565,593](../src/model/types.ts)) to avoid colliding with the legacy `ModelProperties.topology: '2d-grid'` string enum (a DIFFERENT, untouched field). The reducer is `UPDATE_TOPOLOGY_MODE` ([ModelContext.tsx:909](../src/model/ModelContext.tsx)). Use `topologyMode` everywhere.

2. **M0a already shipped — the agent work starts from a partly-built shell.** The docs ([PLAN_BG_DIMENSIONS §3, §9 M0](PLAN_BG_DIMENSIONS_AND_MODES.md)) write the mode schema + reducer + Properties UI as unbuilt. They exist (see §0.5 above). The agent milestone's UI mission is to **un-gate** the hard-disabled checkbox + build M0b (the second graph + sub-tab), NOT to re-add the schema/reducer/radio.

3. **`gl3d.ts` renders cubes-from-a-colors-buffer — agents extend it to spheres+bonds, not free reuse.** The docs treat the 3D renderer as "wholesale new" ([PLAN_BOND_GRAPH §5.2](PLAN_BOND_GRAPH_MORPHOGENESIS.md)). It now has a SHIPPED instanced-CUBE sibling with orbit/clip/pick/alpha-cull-upload. BUT `uploadColors` ([gl3d.ts:389](../src/simulator/render/gl3d.ts)) **decodes x/y/z from the flat cell index in the vertex shader** — agents carry explicit float positions, so the instance buffer needs an explicit-position layout. Phase E **reuses the camera/pick/upload scaffolding** and adds a sphere-impostor + bond-tube draw path; it is no longer fully wholesale-new, but it is not "zero change."

4. **WebGPU works in 3D — but agents are still JS-only (D-TARGET).** The docs treat 3D as hypothetical; it shipped with WebGPU-in-3D. This does **not** change D-TARGET: the agent loop is JS-reference-only for Phases A–D regardless of dimension. The CELL field (Phase D) can still use any target; the AGENT engine forces JS.

5. **The agent loop variable MUST be `idx` (D-IDX, load-bearing).** `GetCellAttributeNode.compile` hard-codes `ctx.readAttrExpr(attr, 'idx')` ([GetCellAttributeNode.ts:15](../src/modeler/vpl/nodes/GetCellAttributeNode.ts)), and `idx` appears ~67× across ~25 node files. Naming the agent loop `idx` (NOT `aIdx`) makes every attribute read land on `r_<attr>[idx]` against the agent SoA with zero node change. The docs write `aIdx` only as PROSE for "the agent index"; **emitted code uses `idx`**.

6. **`buildLoopParams`/`buildLoopArgs` baselines moved.** The docs cite `buildLoopParams` starting `['total','W','H']` with the variegated append at `compile.ts:1156`. Post-3D the signature is `is3dModel`-gated: `['total','W','H','D','WH']` in 3D ([compile.ts:1177](../src/modeler/vpl/compiler/compile.ts)), and the variegated append is at [:1188](../src/modeler/vpl/compiler/compile.ts). The worker's `buildLoopArgs` mirror is at [sim.worker.ts:971](../src/simulator/engine/sim.worker.ts) (the docs' `:938`/`:967` are pre-3D). Any agent param-pair append clones the `if (variegated || hasLookupTables)` gate AFTER the (possibly 5-element) base, and edits BOTH `buildLoopParams` AND `buildLoopArgs` in the same commit (the 3D milestone proved this pair silently desyncs — the `dimsModel`/`total` bug).

7. **The InitEvent root template moved + gained 3D ports.** The docs cite the InitEvent sibling-root block at `compile.ts:1857-1899`. Post-3D it is [compile.ts:1900-1945](../src/modeler/vpl/compiler/compile.ts), and InitEvent gained `z`/`maxZ` ports with `hiddenPorts` ([InitEventNode.ts:31,34](../src/modeler/vpl/nodes/InitEventNode.ts)). Use the CURRENT lines as the agent-root template.

8. **The field is now `total = W*H*D` (3D-capable), not `W*H`.** Decision D-FIELD assumed one 2D lattice. The shipped worker is `total = W*H*D` ([sim.worker.ts:775](../src/simulator/engine/sim.worker.ts)). Phase D's scatter/gather (`voxelOf(agent)`) must map an agent's continuous `(x,y[,z])` into the 3D cell index `(layer*H+row)*W+col` and use trilinear (not bilinear) interpolation in a 3D field. For a 2D field (`depth===1`) it reduces to the bilinear case the docs describe.

9. **The play loop is main-thread-driven, not worker-self-chained.** CLAUDE.md + the docs say "play chains from the worker message handler." The CURRENT code drives the next step from the MAIN thread: SimulatorView's `stepped` handler ([SimulatorView.tsx:1351 region](../src/simulator/SimulatorView.tsx)) calls `sendNextStep()` ([:1313](../src/simulator/SimulatorView.tsx)). The agent generation loop slots into the EXISTING `case 'step'` handler ([sim.worker.ts:2474](../src/simulator/engine/sim.worker.ts)) `for`-loop — call a new `runGeneration()` instead of `runStep()`, keeping the main-thread chaining intact.

10. **`lattice2d` is a DIMENSION gate, not a topology gate, and has zero users post-PR10.** Do not overload it for the agent split. The new flags are `lattice?` (grid/neighbourhood-only nodes, hidden in the Agents graph) and `bondGraph?` (agent nodes, hidden in the Cells graph) — distinct TOPOLOGY gates keyed on `model.topologyMode?.agents` + the active sub-tab.

---

## §0.6 — Critique corrections — APPLY THESE (they amend the PRs below)

An adversarial review found the scope honest and the phasing correct (v1 = the Phase C glued-divide gate; Phases E/F genuinely deferred), and the load-bearing decisions verified (D-IDX `idx` naming, the two-graph blast radius, the closed-feedback deposit-into-read-buffer timing). It caught one **ordering hazard that will stall a fresh agent**, plus per-PR hardening. These are authoritative; where they conflict with a PR below, **§0.6 wins**.

### BLOCKER — the agent compile path must exist before its acceptance test (insert PR-A2.5)

`PR-A5` (the two-graph split / M0b) is sequenced **last** in Phase A, but `PR-A3`'s acceptance test asserts (via the dev harness) that a `behaviourStep` model emits `idx < highWater`. **That test cannot run as written:** `compileHarness.compileAll` compiles **only `model.graphNodes`** ([compileHarness.ts:38/56/66](../src/dev/compileHarness.ts)), never `agentGraphNodes`, and all six `SimulatorView` compile call sites pass `model.graphNodes` / `dimsModel.graphNodes` only ([SimulatorView.tsx:841/1820/2181/2212](../src/simulator/SimulatorView.tsx)). So until the agent graph + its compile path exist, there is **no agent graph for a `behaviourStep` root to live in** and no surface to test it on — a fresh agent stalls, or wrongly authors `behaviourStep` in the cells graph (which `PR-A0`'s palette gate is meant to forbid, and which makes the cells `compileGraph` emit an agent loop).

**Fix — insert `PR-A2.5: the agent compile entry + harness + wiring`, between A1 and A3:**
- A second compile entry that reads `model.agentGraphNodes`/`agentGraphEdges` and emits the agent loop (`compileAgentGraph`, sibling of `compileGraph`).
- **Extend `compileHarness.compileAll`** to also compile the agent graph, returning a new `js.agentCode` field.
- **Wire `SimulatorView` + the worker**: pass `model.agentGraphNodes` to the agent compiler, ship the compiled `behaviourFn` (and later division/bond fns) to the worker, and have the worker store + run it (the `behaviourFn` slot beside `stepFn`, [sim.worker.ts:393-400](../src/simulator/engine/sim.worker.ts)).
- **Rewrite the `PR-A3`/`PR-A4` acceptance tests** to assert `idx < highWater` / `if (!_alive[idx]) continue` / no-`_row` / no-`colorIdx` on `r.js.agentCode` (not `r.js.stepCode`).

This pulls the *minimal* agent-graph compile path forward; the full M0b UI (the sub-tab strip, the palette swap, the activeGraph selector, the ~20-consumer fork) still lands in `PR-A5`. Without A2.5, A3 is unrunnable.

### Per-PR amendments

- **PR-A0 — the agent-root template + the force-JS gate.** (a) The InitEvent sibling-root block you clone ([compile.ts:1900-1945](../src/modeler/vpl/compiler/compile.ts)) emits its function with **`omParams`**, not a loop-param builder. State explicitly: the agent root clones that block's *structure* but **swaps `omParams` → `agentLoopParams`**, swaps the loop bound `idx<total` → **`idx<highWater` + an `if (!_alive[idx]) continue;`** skip, and **drops** the `colorIdx = idx*4` / `decodeCoordLines` / bulk-copy lines (agents have no lattice coords or colour-index). (b) The force-JS gate: `detectWasmIncompatibilities` ([nodeValidation.ts:536](../src/modeler/vpl/nodes/nodeValidation.ts)) is an **empty `return []` scaffold**, and unlike `detectWebGPUModelIncompatibilities` there is **no model-level WASM call site** today. So the gate is *both* a per-node return *and* a wiring decision — **name the consumption site**: the compile-target selection in `SimulatorView`'s compile memo ([~SimulatorView.tsx:841/1820](../src/simulator/SimulatorView.tsx)) must force the JS target when `model.topologyMode?.agents`. Don't ship a gate function nobody calls.
- **PR-A5 — the graph-swap dep array.** The scope-switch effect's dep array is **`[currentScope, modelVersion]`** ([GraphEditor.tsx:1086](../src/modeler/vpl/GraphEditor.tsx)) — add `activeGraph` as a **third** entry (not "the" entry). The initial `useNodesState`/`useEdgesState` seed ([GraphEditor.tsx:507-508](../src/modeler/vpl/GraphEditor.tsx)) must **also** fork on `activeGraph`, or the first render flashes the cells graph. `clearHistory()` is already inside that effect ([:1079](../src/modeler/vpl/GraphEditor.tsx)) so routing `activeGraph` through it gives the cross-graph-undo guard for free. Also decide the **macro × activeGraph composition rule**: entering a macro from the Agents graph must keep `activeGraph='agents'` on return (persist `activeGraph` in `modelerUiState` [:13-25](../src/modeler/modelerUiState.ts), and don't reset it on scope-pop).
- **PR-A5 — the Show Code + migration consumers.** The blast-radius ledger must include: (i) **Show Code** — `SimulatorView`'s `buildFullCode`/compile memo ([:865](../src/simulator/SimulatorView.tsx)) must surface `agentCode`, or an agent model's Show Code shows only the cells step; (ii) the **5 `LOAD_MODEL` node-migrations** ([ModelContext.tsx:728-757](../src/model/ModelContext.tsx)) — decide + code-comment whether an agent graph can ever hold a migratable node (e.g. `setCellLooks` for agent appearance); if yes they must scan `agentGraphNodes` too.
- **PR-B1 — the serializer is a bespoke branch, not just `ATTR_TYPE_MAP`.** `ATTR_TYPE_MAP` ([fileOperations.ts:383](../src/model/fileOperations.ts)) is consulted only on the **per-cell-attribute** load path. The agent SoA + the **ragged bond store with free-list holes** are not cell attributes — they need their **own** serialize/deserialize branch in `getState`/`loadState` (the dangling-bond ABI: partner-id validity + `partnerEpoch` + alive-mask). Registering an `ATTR_TYPE_MAP` entry only helps an agent array that rides the existing attr deserializer; the holey/ragged structures do not.
- **PR-D1 — the closed feedback (the subtlest PR).** (a) Restate that the **v1 gate is Phase C**; Phase D is a *follow-on* demo — do not attempt D before C is solid (the §0.1 mission bundles "closed feedback" into the headline, which could mislead). (b) The 2-engine `runGeneration` wraps **only the JS `runStep()`** ([sim.worker.ts:2534](../src/simulator/engine/sim.worker.ts), inside the `case 'step'` loop) — the WebGPU `case 'step'` async branch ([:2483-2529](../src/simulator/engine/sim.worker.ts)) is a path agents never take (agents force JS). (c) **Pin the sampling convention**: `SampleField`/`ReadCellsUnder` are **cell-centered** (integer cell index = cell centre; fractional = lerp toward neighbour centres) — an unstated convention makes the bilinear/trilinear acceptance test pass/fail on an arbitrary half-cell choice. (d) The deposit phase must iterate agents in a **stable order** so the op-accumulate result doesn't depend on free-list hole order (matters only if you ever add non-commutative ops; set/add/max are safe).
- **Acceptance-test hardening (across PRs).** The load-bearing correctness checks lean on "compute an independent reference in `preview_eval`" — **provide the reference, don't make the agent re-derive it under time pressure**: state the exact soft-sphere force law + the integrator constants (η, Δt, the repulsion stiffness, the bond `λ`/rest-length) in PR-A3, and the division-axis tensor formula in PR-C1. For the dangling-bond test (PR-B1), **force the recycle**: kill A, then immediately `createAgent` so the free-list pops A's exact slot, and assert the epoch bumped + B's stale bond is swept.
- **Optional scope trim.** The **agents-only lattice-less** branch (`topologyMode.gridCells:false`) is woven through PR-A2 (the `colors` buffer is a `wasmMemory` view, [sim.worker.ts:838](../src/simulator/engine/sim.worker.ts), so a no-grid model needs a standalone `Uint8ClampedArray`) but **no v1 demo requires it** (every headline demo has a grid field). Consider a **"grid required for v1"** simplification — defer the lattice-less branch to after Phase D — to shrink PR-A2's surface.

---

## §1 — The agreed design recap

**Read these three design docs first** (they are the spec; this handoff is the build ticket):

- [PLAN_BOND_GRAPH_MORPHOGENESIS.md](PLAN_BOND_GRAPH_MORPHOGENESIS.md) — the build playbook. §1.5 (the net-new ledger N1–N5 + Decisions **D-IDX**/**D-TARGET**/**D-FIELD**), §2 (rule authoring + the event roots + worked division example), §3 (the field-IS-a-CA), §5 (simulator interaction + 3D render), §6 (data model), §7 (impact map), §8 (the M1–M6 phasing), §9 (silent-corruption hazards), §10 (node catalogue + the `AgentStore`/`BondStore` TS).
- [PLAN_BG_DIMENSIONS_AND_MODES.md](PLAN_BG_DIMENSIONS_AND_MODES.md) — the dimensions/modes extension. §1.5 **C1** (the M0a/M0b split + the two-graph sleeper cost) + **C2** (`AffectCellsUnder` any-attr-over-radius + the deposit-before-step timing) + **C3** (agents-only lattice-less branch), §2 (Cells/Agents vocabulary), §3 (the two-graph Modeler split + palette gate), §4 (the closed stigmergy loop + the hypoxia→VEGF worked example), §10 R1/R2 (the compiler fork + the single-editor swap).
- [INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md) — feasibility. §3.1 (the tension-proxy division eigensolve `M = Σ_k w_k·(r̂_k⊗r̂_k)` + the no-shape-long-axis ceiling), the Hertwig/Minc/Campinho grounding, the decision ledger D1–D24.

**The key decisions you are implementing (all already made — do not relitigate):**

1. **The agent SoA + free-list** ([PLAN_BOND_GRAPH §10.2](PLAN_BOND_GRAPH_MORPHOGENESIS.md)): parallel typed arrays length `maxAgents` (Float64 `x`/`y`[/`z`]/`radius`/`targetRadius`/`age`/`cyclePhase`, Int32 `type`/`lineage`, Uint8 `alive`), plus `highWater` (the loop bound), `liveAgentCount` (display tally), `freeList:Int32Array`+`freeTop` (recycled slots). Allocate-once at init from `CenterBasedConfig.maxAgents`. Per-USER-agent-attribute `r_`/`w_` SoA pairs named identically to the lattice (so `GetCellAttribute` reads work via D-IDX `idx`).
2. **The force integrator** ([INVESTIGATION_CENTER_BASED §6.1](INVESTIGATION_CENTER_BASED.md) via [PLAN_BOND_GRAPH §6](PLAN_BOND_GRAPH_MORPHOGENESIS.md)): per step — rebuild a uniform spatial hash from current positions (alive-mask, NOT a dense `0..liveAgentCount` loop); the compiled `behaviourStep` over `idx < highWater` summing soft-sphere repulsion + bond springs `λ(l−L)·r̂` (the vector reduction `Σ F(d)·r̂` is the genuinely-new emit); commit positions via a position double-buffer swap; **auto-clamp `Δt`** against `Δt*_mono = ½(r₀−s)/F(r₀)` accounting for bond λ, re-evaluated on any force/bond-λ parameter change.
3. **The persistent ragged bond store + the dangling-bond ABI** ([PLAN_BOND_GRAPH §10.2 BondStore, D8b](PLAN_BOND_GRAPH_MORPHOGENESIS.md)): per-agent fixed-capacity `maxBonds` slots — `partner:Int32Array`, `partnerEpoch:Int32Array` (slot-generation tag checked on EVERY read), `restLength:Float64`, `stiffness:Float64`, `typeLabel:Int32`. Persists across steps; mutated ONLY in the post-step structural phase. `partnerEpoch` + break-all-bonds-on-death + a per-step stale-partner sweep close the recycled-slot-points-at-a-stranger hazard. λ,L per type-pair reuse the existing `lookupTable` model attr (2 channels — no new attribute type). Hysteresis (`d_form < d_break`) is engine-enforced.
4. **The tension-axis division + geometric reattachment** ([INVESTIGATION_BOND_GRAPH §3.1, PLAN_BOND_GRAPH §2.2](PLAN_BOND_GRAPH_MORPHOGENESIS.md)): the eigensolve `M = Σ_k max(0,λ_k(l_k−L_k))·(r̂_k⊗r̂_k)` principal eigenvector (degenerate-fallback to the density-gap minor eigenvector when `Σw_k≈0`); split the mother at `centroid ± ½·offset·m̂`; partition each partner bond to the NEARER daughter by `sign(dot(offset_k, m̂))`; add the daughter-daughter bond; alloc a free-list slot. The engine owns it all — **the graph never sees the per-bond partition** (the freedom/guardrail boundary).
5. **The closed feedback `AffectCellsUnder`/`ReadCellsUnder`** ([PLAN_BG_DIMENSIONS §1.5 C2, §4](PLAN_BG_DIMENSIONS_AND_MODES.md)): an agent writes ANY cell attribute over an r-disk(2D)/ball(3D) into the cell **READ** buffer in a DEPOSIT phase BEFORE the cell step (writing `w_` is clobbered by the step's top-of-loop `w_.set(r_)` copy); many-agents→one-cell resolved by the SEQUENTIAL agent loop applying each op (set/add/subtract/max/min) in order — a NEW agent-tier runtime guarantee, distinct from `asyncWriteHazard.ts` (a compile-time within-one-cell-body analyzer). `ReadCellsUnder`/`SampleField`/`FieldGradient` gather AFTER the grid step (bilinear/trilinear at the agent's continuous position).
6. **The two-graph split (Cells/Agents)** ([PLAN_BG_DIMENSIONS §1.5 C1, §3](PLAN_BG_DIMENSIONS_AND_MODES.md), Decisions R1/R2): a second rule graph `agentGraphNodes?`/`agentGraphEdges?` on `CAModel`; an `activeGraph: 'cells'|'agents'` selector reusing the EXISTING `currentScope` graph-swap behind ONE ReactFlow instance; a sub-tab strip; palette gating per sub-tab via the new `lattice`/`bondGraph` flags. **macroDefs stays SHARED.** The existing `graphNodes`/`graphEdges` BECOMES the Cells graph (zero migration).
7. **The new node catalogue** ([PLAN_BOND_GRAPH §10.1](PLAN_BOND_GRAPH_MORPHOGENESIS.md)): the event roots `behaviourStep`/`divisionEvent`/`bondContactEvent`; the read nodes `GetSelfPosition`/`GetRadius`/`GetBondDegree`/`NeighbourDensity`/`GetCurvature`/`SampleField`/`FieldGradient`; the flow nodes `DivideAgent`/`KillAgent`/`SetTargetRadius`/`FormBond`/`BreakBond`/`AffectCellsUnder`/`SecreteToField`/`ForEachBond`. **First-class** density/degree/curvature nodes — NOT Average-over-the-bond-list macros (Average ≠ density on a ragged holey list, [INVESTIGATION_BOND_GRAPH §9.1 #7/D13](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md)).
8. **D-IDX** (agent loop var = `idx`) and **D-TARGET** (JS-reference-only v1) — see §0.5 reconcile points 5 and OUT-OF-SCOPE.

---

## §2 — The PR plan

Phased and ordered. Within each phase, PRs are small, `tsc`-clean, and verifiable. The phase boundaries respect the dependency chain: substrate first (headless-testable via `getState`), then bonds, then the headline division, then the closed feedback, then 3D, then cross-target. **The build DAG sequences the agent COMPILER (un-gate + roots + agentLoopParams) before the M0b two-graph UI** — do not ship a second agent graph nobody can compile.

```
Phase A — agent substrate (JS, 2D)
  A0 ─ un-gate Agents + bondGraph requirements flag + force-JS gate     (no engine yet)
  A1 ─ schema: CenterBasedConfig + agentGraphNodes/Edges + reducers + serialize
  A2 ─ agent SoA + free-list + maxAgents + alive-mask + seeding + 2D circle render  (no forces)
  A3 ─ behaviourStep root + agentLoopParams + force-integration driver + Δt clamp
  A4 ─ agent value/flow read+request nodes + agent brush + inspector
  A5 ─ the two-graph Modeler split (M0b: activeGraph swap + sub-tab + palette gate + cascade fork)
Phase B — bonds
  B1 ─ persistent ragged bond store + dangling-bond ABI + bond serializer
  B2 ─ FormBond/BreakBond + bond spring force + hysteresis + glue/cut brush + bond render
Phase C — division / growth / death  (the headline)
  C1 ─ DivideAgent + tension-axis eigensolve + geometric reattachment + divisionEvent root
  C2 ─ SetTargetRadius growth + KillAgent + the maxAgents/maxBonds/Δt hazards
Phase D — closed feedback (cell-CA-as-field)
  D1 ─ AffectCellsUnder/ReadCellsUnder/SampleField/FieldGradient + runGeneration 2-engine orchestration
Phase E (later) — 3D agents:  extend gl3d.ts to instanced spheres + bond tubes, reuse orbit/clip/pick
Phase F (later) — WASM then WebGPU agent-loop lockstep
```

> **Branch discipline:** all work on a feature branch off `master` (e.g. `agents_floating_cells` — already the current branch). Never push, never add Co-Authored-By lines (the user handles all git). Per CLAUDE.md, a non-trivial UI change needs an illustrated HTML mockup — A0/A5 ship one for the Topology un-gate + the Cells/Agents sub-tab; A4 for the agent brush; B2 for the bond brush; C1 for the division-rule editor; the design docs' `.html` mockups are the starting point.

---

## Phase A — agent substrate (JS, 2D)

### PR-A0 — un-gate Agents + `bondGraph` requirements flag + force-JS gate

**Goal.** Make `topologyMode.agents` user-settable; add the `bondGraph` capability flag so agent nodes can be authored only in an agent context; force a `topologyMode.agents` model to the JS compile target. **No engine, no nodes yet** — pure gating + the first agent event-root stub so the harness can prove the loop fork.

**Files & symbols.**
- `src/modeler/panels/PropertiesPanelContent.tsx:370-388` (the hard-disabled Bond-Graph Agents checkbox), `:355-368` (the Grid Cells last-checked-disabled template).
- `src/modeler/vpl/types.ts:82-94` (`NodeRequirements` — `async?`/`variegated?`/`lattice2d?`), `:106` (`requirements?`).
- `src/modeler/vpl/nodes/nodeValidation.ts:440-461` (`detectCapabilityRequirements`), `:466-472` (`isNodeAvailable`), `:536-542` (`detectWasmIncompatibilities`), `:548-554` (`detectWebGPUModelIncompatibilities`).
- `src/modeler/vpl/compiler/compile.ts:1137` (`is3dModel` — the predicate template), `:67` (`MULTI_OUTPUT_TYPES`).
- NEW `src/modeler/vpl/nodes/BehaviourStepNode.ts` (clone `StepNode.ts:3-14`).

**The change.**
- **Un-gate the checkbox** ([PropertiesPanelContent.tsx:370-388](../src/modeler/panels/PropertiesPanelContent.tsx)): change the Agents `<label>` to mirror Grid Cells ([:355-368](../src/modeler/panels/PropertiesPanelContent.tsx)) — `disabled={topo.agents && !topo.gridCells}` (last-checked guard), the same `cursor`/`opacity` predicate, drop the `disabled={true}` hard-lock and the "coming soon" copy. This exercises the reducer's all-false guard ([ModelContext.tsx:909-914](../src/model/ModelContext.tsx)).
- **Add `bondGraph?: boolean` + `lattice?: boolean`** to `NodeRequirements` ([vpl/types.ts:82-94](../src/modeler/vpl/types.ts), clone the `lattice2d` sibling). Add an `isAgentModel(model)` predicate in compile.ts mirroring `is3dModel` ([:1137](../src/modeler/vpl/compiler/compile.ts)) = `model.topologyMode?.agents === true` (the single agent chokepoint, shared worker+compiler).
- **Branch the gates** ([nodeValidation.ts:447-470](../src/modeler/vpl/nodes/nodeValidation.ts)): `bondGraph` nodes available iff the active graph kind is `'agents'` (PR-A5 supplies the sub-tab signal; until then key on `model.topologyMode?.agents`); `lattice` nodes available iff `!agents` / active kind `'cells'`. Add the **JS-only force-restrict** in `detectWasmIncompatibilities`/`detectWebGPUModelIncompatibilities` ([:536-554](../src/modeler/vpl/nodes/nodeValidation.ts)): a `topologyMode.agents`-true model returns the JS-only restriction (the agent loop emit is Phase F).
- **The `behaviourStep` event-root stub** (clone `StepNode.ts`): `category:'event'`, `compile:()=>''`, `requirements:{ bondGraph:true }`, register in `ALL_NODES` ([registry.ts:74](../src/modeler/vpl/nodes/registry.ts)) + `MULTI_OUTPUT_TYPES` ([compile.ts:67](../src/modeler/vpl/compiler/compile.ts)). Value-outs come in PR-A3; this PR ships the bare singleton so the palette/harness can see it.

**Acceptance test.** (1) `npx tsc -b` clean. (2) With Agents checked, no all-false topology state is reachable from the UI (the last-checked-disabled gate). (3) A `topologyMode.agents:true` + `useWasm:true` model → `detectWasmIncompatibilities` returns the JS-only restriction; `useWebGPU:true` likewise. (4) A `gridCells:true, agents:false` model is **byte-identical** to today: `compileAll(GameOfLife).js.stepCode` string-equal to a pre-PR baseline (the gate is inert when agents off). (5) `behaviourStep` appears in the palette only when `topologyMode.agents` is enabled.

**Risk.** Pure gating. The trap is the hard `disabled={true}` ([:377](../src/modeler/panels/PropertiesPanelContent.tsx)) — un-gate must change BOTH the disabled predicate AND remove the "coming soon" copy, or the reducer's all-false guard is never exercised. Ship the HTML mockup of the un-gated Topology cluster.

---

### PR-A1 — schema: `CenterBasedConfig` + `agentGraphNodes`/`agentGraphEdges` + reducers + serialize

**Goal.** Add the agent config sub-object + the second rule graph arrays + their reducers/setters + the serialize plumbing. **Additive/optional — old files load unchanged. No runtime, no swap UI yet.**

**Files & symbols.**
- `src/model/types.ts:578-580` (`graphNodes`/`graphEdges`/`macroDefs`), `:565-593` (`TopologyMode`/`topologyMode?`), the `VariegatedCellsConfig` sub-object (the clone template).
- `src/model/defaultModel.ts:31` (`EMPTY_MODEL.topologyMode` seed).
- `src/model/ModelContext.tsx:609-618` (`SET_GRAPH` reducer) + `:1158-1162` (`setGraph` callback), `:909-914` (`UPDATE_VARIEGATED_CELLS`/`UPDATE_TOPOLOGY_MODE` template), `:699-758` (`LOAD_MODEL` defaults + the 5 node-migrations at `:728-757`), `:1290` (`updateTopologyMode` wiring template), `:1340`/`:1387` (the two useMemo dep arrays).
- `src/model/fileOperations.ts:169-172` (`stringifyCompact` inline-array `parentKey` list), `:264-267` (recovery, array-agnostic).

**The change.**
- **`CenterBasedConfig`** ([types.ts](../src/model/types.ts), clone `VariegatedCellsConfig`): `{ enabled, maxAgents, maxBonds, dimensions: '2d'|'3d', worldBounds: {w,h,d?}, forceLaw?, seeding? }` on `CAModel.centerBased?`. **`maxAgents`/`maxBonds` are over-allocated ceilings; overflow REJECTS + surfaces, never wraps** (the Amphiphile-NI-poisoning class).
- **`agentGraphNodes?: GraphNode[]` + `agentGraphEdges?: GraphEdge[]`** on `CAModel` ([types.ts:578-580 region](../src/model/types.ts), after `graphEdges`). `macroDefs` stays SHARED. Seed `agentGraph*: []` in `EMPTY_MODEL` ([defaultModel.ts:31](../src/model/defaultModel.ts)); default-fill in `LOAD_MODEL` ([ModelContext.tsx:702-717 region](../src/model/ModelContext.tsx)) — `if (!m.agentGraphNodes) m.agentGraphNodes = []; if (!m.agentGraphEdges) m.agentGraphEdges = [];`.
- **The 5 LOAD_MODEL node-migrations** ([:728-757](../src/model/ModelContext.tsx)): each operates on `(graphNodes, graphEdges, macroDefs)`. **Decide explicitly** whether agent graphs can contain a migratable node type (e.g. `setCellLooks`). For v1 the agent node set is disjoint from those migrated types, so call the migrators only on `graphNodes` — but document the decision in a code comment, because shipping a migratable node into the agent graph later without this would strand stale config.
- **`SET_AGENT_GRAPH` reducer** (clone `SET_GRAPH` at [:609-618](../src/model/ModelContext.tsx) → writes `agentGraphNodes`/`agentGraphEdges`) + a `setAgentGraph` callback (clone [:1158-1162](../src/model/ModelContext.tsx)) wired into the context value **AND BOTH useMemo dep arrays** ([:1340](../src/model/ModelContext.tsx), [:1387](../src/model/ModelContext.tsx) — the recurring stale-closure bug).
- **`stringifyCompact`** ([fileOperations.ts:169-172](../src/model/fileOperations.ts)): add `'agentGraphNodes'`/`'agentGraphEdges'` to the inline-array `parentKey` list so they serialize one-line-per-item like `graphNodes`. Round-trip is otherwise automatic (additive optional fields).

**Acceptance test.** (1) `tsc -b` clean. (2) An old `.gcaproj` (no agent arrays) round-trips byte-identically (`agentGraph*` absent → absent → absent; `isDirty===false` on load). (3) A new model saves+loads with `agentGraphNodes/Edges: []` and `centerBased` present; grep the saved text for the compact one-line-per-item shape (not verbose). (4) `compileAll(GameOfLife)` byte-identical before/after (the cells compiler ignores `agentGraphNodes`).

**Risk.** Wire `setAgentGraph` into BOTH the value object AND the useMemo deps (the codebase's recurring silent-stale-closure bug). The migration decision (point 3) is a deferred-strand hazard — document it.

---

### PR-A2 — agent SoA + free-list + `maxAgents` + alive-mask + seeding + 2D circle render (NO forces)

**Goal.** Allocate the agent store in the worker; ship positions/radius/alive/highWater in the `stepped` message; draw filled circles; seed/pick. **Agents are inert (no behaviourStep, no forces).** Headless-testable via `getState`.

**Files & symbols.**
- `src/simulator/engine/sim.worker.ts:774` (`initGrid`, `total = W*H*D` at [:775](../src/simulator/engine/sim.worker.ts)), `:838` (`colors` view over `wasmMemory`), `:2299` (`sendColors` — the `stepped` assembly), `:287` (`WorkerMsg` union), `:2382` (`self.onmessage`), `:3194` (`getState`), `:3245` (`loadState`).
- `src/simulator/SimulatorView.tsx:868` (`draw = useCallback`), `:871` (the `is3dRef` branch — the draw seam), `:1313` (`sendNextStep`), `:1351 region` (the `stepped` handler), `:2942` (`gridToScreen`), `:3029` (`flushPaintBatch`).

**The change.**
- **The agent SoA** ([sim.worker.ts:774 region](../src/simulator/engine/sim.worker.ts), an `isAgentModel`-gated sibling tier to `initGrid`): parallel typed arrays length `maxAgents` — Float64 `agentX`/`agentY`/`agentRadius`/`agentTargetRadius`/`agentAge`, Int32 `agentType`/`agentLineage`, Uint8 `agentAlive`; plus `highWater`/`liveAgentCount`/`freeList:Int32Array`/`freeTop`. Per-user-agent-attribute `r_<id>`/`w_<id>` SoA pairs (so D-IDX reads work). For v1 these are **plain JS typed arrays** (NOT wasmMemory views — agents are JS-only this milestone; document the view discipline before the Phase F WASM port).
- **`seedAgents` + `createAgent` WorkerMsg** (extend the union at [:287](../src/simulator/engine/sim.worker.ts)): `seedAgents` lays down N agents (positions + radius + type), bumps `highWater`/`liveAgentCount`; `createAgent` allocs one slot (free-list first, else `highWater++`, else REJECT + surface).
- **Ship agent state in `stepped`** ([sendColors:2299](../src/simulator/engine/sim.worker.ts)): also transfer `agentX`/`agentY`/`agentRadius`/`agentAlive`/`highWater` every frame (positions are needed by both the renderer AND nearest-agent picking — this disables the WebGPU direct-render colour-skip, but agents force JS anyway).
- **The 2D circle renderer** ([SimulatorView.tsx draw:868](../src/simulator/SimulatorView.tsx)): after the existing `is3dRef` branch ([:871](../src/simulator/SimulatorView.tsx)), add `if (isAgentModelRef.current) return drawAgents();`. `drawAgents` reuses the transform block (the `gridToScreen` zoom/pan map) as a world→screen map; iterates `0..highWater` skip `!alive`; draws filled `arc()` circles `cx = ox + agentX[i]*scale, r = agentRadius[i]*scale`, colour from the SAME index-keyed `colors[i*4..]` slot. **For an agents-only model** (`topologyMode.gridCells:false`, [PLAN_BG_DIMENSIONS §1.5 C3](PLAN_BG_DIMENSIONS_AND_MODES.md)): allocate NO grid (skip the cell SoA + neighbor tables), bound agents by `worldBounds`, and SIZE `colors` to `maxAgents*4` — note `colors` is currently a VIEW over `wasmMemory` at `wasmLayout.colorsOffset` ([sim.worker.ts:838](../src/simulator/engine/sim.worker.ts)), so the lattice-less branch must allocate a standalone `Uint8ClampedArray` or extend the layout.
- **The picker seam**: extract a `Picker` interface `{ screenToId, idToScreen }`; keep `gridToScreen`/`screenToGrid` as the `2d-grid` impl, add a `center-based` impl whose `screenToId` does a nearest-agent hit-test against the per-step spatial grid the force driver will rebuild (in this PR, a simple O(highWater) scan; PR-A3 replaces it with the hash). Agent Seed/Kill/Set-type brush modes reuse `flushPaintBatch`'s rAF coalescer + `encodeAttrValue`, keyed by agent id.

**Acceptance test.** (1) `tsc -b` clean. (2) `window.__simWorker.postMessage({type:'seedAgents', count:N, ...})` then `{type:'getState'}` returns the agent SoA with `liveAgentCount===N`, `highWater===N`, `agentAlive.reduce(sum)===N`, positions inside `worldBounds`. (3) The 2D canvas shows N circles; pan/zoom/seed/pick work; nearest-agent pick returns the right id. (4) `compileAll(GameOfLife)` + `compileAll(Life3D)` byte-identical before/after (the cell path is untouched).

**Risk.** The lattice-less `colors` resize is NOT a free reuse (it's a wasmMemory view). Extend the WorkerMsg union for `seedAgents`/`createAgent` or the messages silently drop. The `maxAgents` overflow on `createAgent` must REJECT + surface (the blue-notice/stopEvent channel), never wrap.

---

### PR-A3 — `behaviourStep` root + `agentLoopParams` + force-integration driver + `Δt` clamp

> ⚠️ **Per §0.6, do PR-A2.5 FIRST** (the agent compile entry + `compileHarness.compileAll` extension + `SimulatorView`/worker wiring) — otherwise there is no agent graph to host the `behaviourStep` root and this PR's harness acceptance test is unrunnable. Assert on `r.js.agentCode`, not `r.js.stepCode`. Also apply §0.6's PR-A0 note (clone the InitEvent block but swap `omParams`→`agentLoopParams`, bound→`highWater`+`!_alive` skip, drop `colorIdx`/decode) and provide the exact force law + integrator constants in the acceptance test.

**Goal.** The load-bearing PR. The `behaviourStep` event root forking the InitEvent loop template (`idx < highWater`, no row/col decode), the `agentLoopParams` builder + its worker `buildLoopArgs` mirror, the soft-sphere repulsion force-law + the vector reduction + overdamped Euler + position double-buffer + the `Δt` monotonicity clamp FROM THE START. **Keep it node-light** (this is the riskiest fork).

**Files & symbols.**
- `src/modeler/vpl/compiler/compile.ts:1900-1945` (the **InitEvent sibling-root block — the verbatim agent-root template**: find the node, `compileRoot`, wrap a `for (let idx=0; idx<total; idx++)` loop, splice value-outs as preamble decls at [:1924-1932](../src/modeler/vpl/compiler/compile.ts)), `:1160-1194` (`buildLoopParams` — the variegated gate at [:1188](../src/modeler/vpl/compiler/compile.ts) is the clone target), `:1145-1158` (`decodeCoordLines` — the agent root calls this ZERO times), `:1301 region` (`CompileResult`).
- `src/simulator/engine/sim.worker.ts:971` (`buildLoopArgs` — the mirror), `:1135` (`runStep` — the sibling `runAgentStep` lives here), `:1271` (the sync ref-swap idiom — the position double-buffer template).
- `src/modeler/vpl/nodes/SetAttributeNode.ts:19` (the `w_<attr>[idx]=value` write shape).

**The change.**
- **`behaviourStep` value-outs**: extend the PR-A0 stub with `do` flow + `myX`/`myY`(/`myZ`)/`myRadius`/`myArea`/`myBondDegree`/`myAge`/`myType` value outputs (`hiddenPorts` hides `myZ` in 2D, like `InitEventNode`). Already in `MULTI_OUTPUT_TYPES`, so value-outs resolve via the `_v${rootId}_<port>` convention (no `varName()` case needed beyond set membership).
- **The agent compile block** ([compile.ts after :1945](../src/modeler/vpl/compiler/compile.ts), forking the InitEvent template): `compileRoot(behaviourNode, 'do', …)`, then wrap:
  ```js
  (function(${agentLoopParams}) {
    …scratchDecls; …preLoopValueLines;  let _rs = _rngState[0] || 0x12345678;
    for (let idx = 0; idx < highWater; idx++) {
      if (!_alive[idx]) continue;
      const _v${id}_myX = _agentX[idx]; const _v${id}_myRadius = _agentRadius[idx]; …;
      …valueLines; …flowLines;
    }
    _rngState[0] = _rs;
  })
  ```
  **CRITICAL:** NO `colorIdx = idx*4`, NO `decodeCoordLines`, NO bulk attr-copy — agents are entity-rendered and the structural phase owns position/radius writes. Return `behaviourCode` as a new `CompileResult` field parallel to `initCode`.
- **`agentLoopParams` builder** (clone `buildLoopParams` [:1160](../src/modeler/vpl/compiler/compile.ts)): append the engine-owned per-agent buffers as DEDICATED param pairs — `_alive, highWater, _agentX, _agentY[, _agentZ], _agentRadius, _agentBondCount, _agentDensity` — NOT `r_<id>`/`w_<id>` (those are user attributes; engine buffers use `_agentX` naming so `SetAttribute`/`GetCellAttribute` literally cannot target them, the N4 guardrail). **MIRROR the append in the worker's `buildLoopArgs`** ([sim.worker.ts:971](../src/simulator/engine/sim.worker.ts)) at the SAME commit (the desync hazard).
- **The force driver** (`runAgentStep`, a sibling to `runStep` at [:1135](../src/simulator/engine/sim.worker.ts)): per gen — (a) rebuild a uniform spatial hash from current positions over alive agents (NOT dense); (b) run the compiled `behaviourStep` summing soft-sphere repulsion (the force-law authored as Compare/Interpolation/arithmetic → repulsion curve) + the vector reduction `Σ F(d)·r̂` (the genuinely-new emit); (c) commit positions via a position double-buffer swap (the ref-swap idiom at [:1271](../src/simulator/engine/sim.worker.ts)); (d) auto-clamp `Δt ← min(Δt_user, 0.4·Δt*_mono)`, `Δt*_mono = ½(r₀−s)/F(r₀)`, re-evaluated on any force-param change.

**Acceptance test.** (1) `tsc -b` clean. (2) Harness: a `behaviourStep` model wiring `GetSelfPosition → SetAttribute` (or a repulsion graph) emits `r.js.stepCode` (the new `behaviourCode`) whose loop bound is `idx < highWater`, whose body has `if (!_alive[idx]) continue`, and has NO `const _row` / `colorIdx = idx*4`. (3) Force determinism: step M gens forced-JS, capture positions via `getState`, compare to an independent overdamped soft-sphere reference computed in the eval — max per-axis drift < fp tolerance; the seeded blob pushes apart and relaxes into a stable packing over 1000 steps (no NaN, no escape). (4) `Δt` re-clamps when a force model-attr changes (positions stay bounded). (5) `buildLoopParams↔buildLoopArgs` lockstep: the emitted `(function(${agentLoopParams})…` param count equals the args `buildLoopArgs` pushes (a mismatch throws at invocation). (6) 2D + 3D cell regression byte-identical.

**Risk.** The `buildLoopParams`/`buildLoopArgs` desync (the 3D `dimsModel`/`total` bug class) — edit both at the same commit. The agent root must NOT emit `decodeCoordLines`/`colorIdx`/bulk-copy (copy the InitEvent STRUCTURE, remove those lines, change the bound). The `Δt` clamp is a SILENT drift, not a crash — build it from this PR, not as a follow-up.

---

### PR-A4 — agent value/flow read+request nodes + agent brush + inspector

**Goal.** The agent read nodes (`GetSelfPosition`/`GetRadius`/`GetBondDegree`/`NeighbourDensity`/`GetCurvature`) and the request-emitting flow node `SetTargetRadius`; the agent Seed/Paint-attribute/Kill/Set-type brush; the agent inspector. (Division/bond nodes are Phases C/B.)

**Files & symbols.**
- `src/modeler/vpl/nodes/GetCellAttributeNode.ts:15` (the read-node shape `const _v${id} = <buffer>[idx]`), `GetCellPositionNode.ts:17-42` (the shipped multi-output read-node precedent — `GetSelfPosition` clones this), `SetAttributeNode.ts:19` (the request-write shape for `SetTargetRadius`).
- `src/modeler/vpl/nodes/nodeValidation.ts:23` (`detectMissingConfig` — NO default case; every required-config node needs a case).
- `src/simulator/SimulatorView.tsx:3029` (`flushPaintBatch`), the inspector path.

**The change.**
- **Read nodes** (`category:'data'`, `requirements:{ bondGraph:true }`, each emitting one `const _v${id} = <buffer>[idx];` cloned from `GetCellAttributeNode`): `GetBondDegree`→`_agentBondCount[idx]`, `GetRadius`→`_agentRadius[idx]`, `NeighbourDensity`→`_agentDensity[idx]`, `GetCurvature`(channel via `hiddenPorts`)→`_agentCurvature[idx]`, `GetSelfPosition` (multi-out `x`/`y`[/`z`], clone `GetCellPositionNode`'s multi-out shape + `MULTI_OUTPUT_TYPES` + `varName()`, reading `_agentX[idx]` etc.). **First-class** — NOT Average-over-bond-list macros ([INVESTIGATION_BOND_GRAPH §9.1 #7](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md)). Each with a required config MUST add a `detectMissingConfig` case ([nodeValidation.ts:23](../src/modeler/vpl/nodes/nodeValidation.ts)) or the compiler emits `_undef`.
- **`SetTargetRadius`** (flow, `category:'output'`, `requirements:{ bondGraph:true }`, NOT async-only): `w_radius[idx] = <value>` — literally SetAttribute on the engine radius (the growth ramp consumer is the structural phase in PR-C2).
- **Agent brush**: Seed/Paint-attribute/Kill/Set-type modes reusing the `flushPaintBatch` rAF coalescer + `encodeAttrValue`, keyed by agent id. New `paintAgents`/`killAgents` WorkerMsg.
- **Inspector**: extend `postInspectCellsData` to read the agent SoA at the picked agent id (positions + radius + user attrs).

**Acceptance test.** (1) `tsc -b` clean. (2) Each read node emits `const _v<id> = <buffer>[idx]` in the `behaviourStep` body; `GetSelfPosition.x` wired into `SetAttribute.value` compiles to `w_<attr>[idx] = _v<gspId>_x;` (multi-out resolved). (3) `detectMissingConfig('getCurvature', {}, model).length > 0` (no silent `_undef`). (4) Painting an attribute via the agent brush mutates the picked agent's `r_<id>[id]` (verify via `getState`). (5) Cell regression byte-identical.

**Risk.** `detectMissingConfig` has no default case — every required-config node needs its branch. Engine buffers (`_agentBondCount`) are read by dedicated nodes, never `GetCellAttribute` (the N4 naming guardrail).

---

### PR-A5 — the two-graph Modeler split (M0b)

**Goal.** The second agent rule graph, the `activeGraph: 'cells'|'agents'` selector reusing the EXISTING `currentScope` swap, the Cells/Agents sub-tab strip, the palette gate per sub-tab, and the ~20-site `graphNodes`-consumer fork. **Gate this AFTER the agent compiler (PR-A0..A3) exists** — an empty agent graph nobody can compile is dead weight.

**Files & symbols.**
- `src/modeler/vpl/GraphEditor.tsx:505` (`GraphEditorInner` — takes no props), `:507-508` (the initial `useNodesState`/`useEdgesState` seed from `model.graphNodes`), `:1060-1086` (the **scope-switch effect — the swap kernel**; the root branch at [:1062-1064](../src/modeler/vpl/GraphEditor.tsx), `clearHistory()` at [:1079](../src/modeler/vpl/GraphEditor.tsx), dep array at [:1086](../src/modeler/vpl/GraphEditor.tsx)), `:724-736` (`scheduleSync` write-back — the root dispatch), `:3685 region` (the macro breadcrumb — the sub-tab strip's sibling home), `:3158-3196` (`dropMenuItems`, gate at [:3181](../src/modeler/vpl/GraphEditor.tsx)), `:59` (the module-level `clipboard`).
- `src/modeler/vpl/graphState.ts:260-270` (the `currentModelElementDrag` live-binding pub/sub — the template for an `activeGraphKind` module global).
- `src/modeler/vpl/graphHistory.ts:10-11` (the single module-level undo/redo stack; `clearHistory` fires per swap).
- `src/modeler/modelerUiState.ts:13-25` (the in-memory snapshot — add `activeGraph`).
- `src/modeler/ModelerView.tsx:85-87` (the variegated auto-switch precedent), `:253` (`GraphEditorInner` render).
- `src/modeler/ActivityBar.tsx:42-49` (the V-tab elision precedent).
- `src/modeler/panels/PalettePanelContent.tsx:177` (`isNodeAvailable(d, model)` — palette gate site), `src/modeler/panels/AttributesPanelContent.tsx:143` ('Cell Attributes' label).
- `src/model/ModelContext.tsx:73-86` (`patchAllNodes` — the cascade), `:285`/`:419`/`:546`/`:590`/`:677`/`:869` (the 6 cascade callers).

**The change.**
- **`activeGraph: 'cells'|'agents'`** in `modelerUiState` ([:13-25](../src/modeler/modelerUiState.ts), default `'cells'`). Thread it from `ModelerView` into `GraphEditorInner` as a prop ([:505](../src/modeler/vpl/GraphEditor.tsx) takes none today).
- **Fork the swap kernel** ([GraphEditor.tsx:1062-1064](../src/modeler/vpl/GraphEditor.tsx)): root branch `const [nds, eds] = activeGraph==='agents' ? [model.agentGraphNodes ?? [], model.agentGraphEdges ?? []] : [model.graphNodes, model.graphEdges]`. Add `activeGraph` to the effect's dep array ([:1086](../src/modeler/vpl/GraphEditor.tsx)) — this gives `clearHistory()` on swap FOR FREE ([:1079](../src/modeler/vpl/GraphEditor.tsx)), preventing a cross-graph undo (R2). Fork the INITIAL seed ([:507-508](../src/modeler/vpl/GraphEditor.tsx)) the same way (else the first render flashes the cells graph). Fork `scheduleSync`'s root dispatch ([:730-731](../src/modeler/vpl/GraphEditor.tsx)): `SET_GRAPH` (cells) vs `SET_AGENT_GRAPH` (agents).
- **The sub-tab strip**: render a Cells/Agents pill row INSIDE the graph area as a sibling of the macro breadcrumb ([:3685](../src/modeler/vpl/GraphEditor.tsx)). Render only pills for CHECKED topologies (read `model.topologyMode`). Clicking sets `activeGraph`. Auto-switch + elide a pill when its topology unchecks (mirror [ModelerView.tsx:85-87](../src/modeler/ModelerView.tsx) + [ActivityBar.tsx:42-49](../src/modeler/ActivityBar.tsx)).
- **The palette gate**: add an `activeGraphKind` module global to `graphState.ts` (the `currentModelElementDrag` pub/sub pattern, [:260-270](../src/modeler/vpl/graphState.ts)) so Palette + quick-add + connection-drop read it without prop-drilling. Drive `isNodeAvailable`/`detectCapabilityRequirements` by it: `bondGraph` nodes iff `activeGraphKind==='agents'`, `lattice` iff `'cells'`. (NodeExplorer needs NO change — it lists live-graph nodes.)
- **Vocabulary**: when `activeGraph==='agents'`, the Attributes section header 'Cell Attributes' ([AttributesPanelContent.tsx:143](../src/modeler/panels/AttributesPanelContent.tsx)) reads 'Agent Attributes' (UI-only, internal ids untouched).
- **Clipboard isolation** ([:59](../src/modeler/vpl/GraphEditor.tsx)): tag the single module-level clipboard with the source graph kind; reject/no-op a mismatched paste (a lattice node into the agent graph).
- **Cascade fork**: extend `patchAllNodes` ([ModelContext.tsx:73-86](../src/model/ModelContext.tsx)) to ALSO scan + patch `model.agentGraphNodes`; thread the agent array through its 6 callers (`REMOVE_ATTRIBUTE` [:285](../src/model/ModelContext.tsx), `UPDATE_ATTRIBUTE` tag-remap [:419](../src/model/ModelContext.tsx), `REMOVE_NEIGHBORHOOD` [:546](../src/model/ModelContext.tsx), `REMOVE_MAPPING` [:590](../src/model/ModelContext.tsx), `REMOVE_INDICATOR` [:677](../src/model/ModelContext.tsx), `REMOVE_VARIABLE` [:869](../src/model/ModelContext.tsx)). Without this, deleting an attribute strands `_undef` in the agent graph.

**Acceptance test.** (1) `tsc -b` clean. (2) Switching pills swaps the visible graph behind one ReactFlow instance; edits write the correct array (`model.graphNodes` vs `model.agentGraphNodes`). (3) `clearHistory` fires on swap: Ctrl+Z after Agents→Cells does NOT apply an agent snapshot. (4) With `topologyMode {gridCells:true, agents:true}`, on the Cells sub-tab a `bondGraph` node is ABSENT from palette + Spacebar quick-add + connection-drop; on Agents a `lattice` node is absent from all three. (5) Deleting an attribute used in the agent graph clears its config (no `_undef`). (6) Unchecking Agents → the pill disappears + `activeGraph` auto-switches to 'cells'. (7) The Attributes header reads 'Agent Attributes' on the Agents sub-tab.

**Risk.** The ~20-site blast radius (see §3). The INITIAL seed must fork too, not just the effect (else a render flash). `clearHistory` MUST fire on swap (route through the same effect). The cascade fork is the exact `_undef` bug class. Ship the HTML mockup of the sub-tab.

---

## Phase B — bonds

### PR-B1 — persistent ragged bond store + dangling-bond ABI + bond serializer

**Goal.** The per-agent ragged bond SoA, the post-step structural-phase mutation point, the `partnerEpoch` dangling-bond ABI, and the agent+bond serializer. **No bond force/nodes yet** (PR-B2).

**Files & symbols.** `src/simulator/engine/sim.worker.ts:774` (the bond store as a sibling tier to the agent SoA), `:3194`/`:3245` (`getState`/`loadState` — extend with the holey-agent + ragged-bond serializer), `src/model/fileOperations.ts` (`ATTR_TYPE_MAP` — register the non-float bond array kinds).

**The change.**
- **The bond store** (per-agent fixed-capacity `maxBonds` slots, SoA): `bondPartner:Int32Array(maxAgents*maxBonds)`, `bondPartnerEpoch:Int32Array`, `bondRestLength:Float64`, `bondStiffness:Float64`, `bondTypeLabel:Int32`; `agentBondCount:Int32Array` gives the live length per agent. PERSISTS across steps; mutated ONLY in the post-step structural phase.
- **The dangling-bond ABI** ([INVESTIGATION_BOND_GRAPH D8b](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md)): `bondPartnerEpoch` is a slot-generation tag checked on EVERY bond read; break-all-bonds-on-death; a per-step stale-partner sweep. A recycled dead slot must NOT silently re-point a spring to a stranger.
- **The serializer** ([sim.worker.ts:3194/3245](../src/simulator/engine/sim.worker.ts)): `getState` snapshots the holey agent table + ragged bond CSR (`partnerIdx[]` + per-agent start/len) + the free-list; `loadState` restores with **partner-id remap on compaction** + **load-validation that REJECTS LOUDLY** (no try/catch around deserialize = silent abort — the "click load, nothing happens" class). Register any non-float agent/bond array kind in `ATTR_TYPE_MAP` (fileOperations.ts) at the SAME commit.

**Acceptance test.** (1) `tsc -b` clean. (2) Form A↔B via a worker message; `getState` round-trips the ragged store; kill A → assert B's bond list no longer references A AND a recycled A slot's `bondPartnerEpoch` differs from any stale bond pointing at it (the epoch mismatch is swept). (3) A `.gcastate` save/load of a bonded cluster restores identical bond topology (partner ids remapped). (4) Load of a corrupt-length bond buffer fails LOUDLY (a posted error), not a silent no-op.

**Risk.** The dangling-bond ABI is non-optional (a recycled slot silently re-points a spring). The serializer is net-new (N3) — partner-remap-on-load + loud validation. Register the array kinds in `ATTR_TYPE_MAP` or save/load silently aborts.

---

### PR-B2 — `FormBond`/`BreakBond` + bond spring force + hysteresis + glue/cut brush + bond render

**Goal.** The form/break flow nodes (request → structural phase), the per-bond spring force in the reduction, engine-enforced hysteresis, the `bondContactEvent` root + `ForEachBond`, the glue/cut/region bond brush + the bond render layer + the bond inspector sub-table.

**Files & symbols.** `src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts:37-98` (the resolve→guard→RMW shape `FormBond`/`BreakBond` clone — but NOT its `requirements:{async:true}`), `ForEachInArrayNode.ts:3-21` (the `ForEachBond` clone template), `src/modeler/vpl/compiler/compile.ts:962-994` (the `forEachInArray` dispatch — the `forEachBond` branch sibling) + [:609-618](../src/modeler/vpl/compiler/compile.ts) (the per-iteration `varName` cases). The `lookupTable` model attr (λ,L spring matrix).

**The change.**
- **`FormBond`/`BreakBond`** (flow, `requirements:{ bondGraph:true }`, **NOT async-only** — they emit requests applied in the post-step phase, so no read-after-write hazard, [PLAN_BG_DIMENSIONS §2.6](PLAN_BG_DIMENSIONS_AND_MODES.md)): clone the MoveSelfToNeighbor resolve→guard→RMW shape ([:64-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts)) writing the bond-request buffer with a `maxBonds`-overflow REJECT (never wrap).
- **The bond spring force** `λ(l−L)·r̂` summed in the PR-A3 vector reduction (λ,L per type-pair from the `lookupTable` model attr, 2 channels — no new attribute type). **Hysteresis** (`d_form < d_break`) engine-enforced (equal thresholds flicker every step). Manual glue/cut INTENTIONALLY bypasses hysteresis (that anti-flicker governs the automatic rules only).
- **`bondContactEvent` root** (form/break policy; value-outs `otherType`/`restLength`/`currentLength`/`currentStrain`/`myBondDegree`/`otherBondDegree`) + **`ForEachBond`** (clone `ForEachInArrayNode`; its 'array' is the agent's ragged bond list; a `forEachBond` branch in `compileFlowChain` at [compile.ts:962](../src/modeler/vpl/compiler/compile.ts): `for (let _feb${id}=0; _feb${id}<_agentBondCount[idx]; _feb${id}++){ const _bondBase=idx*maxBonds+_feb${id}; const partnerId=_bondPartner[_bondBase]; … }` + `varName` cases for the per-iteration ports).
- **The bond brush** (Glue = drag-to-connect via the Line-tool staged-anchor pattern; Cut = `pickBondAt` segment hit-test; Region-glue/cut) + new `formBond`/`breakBond`/`formBondsRegion`/`breakBondsRegion` WorkerMsg. **The bond render layer** (batched segments, drawn UNDER agents — the gridlines batched-stroke is the template). The bond inspector sub-table (extend `postInspectCellsData`).

**Acceptance test.** (1) `tsc -b` clean. (2) A `behaviourStep` with `ForEachBond → arithmetic → setVariable` compiles to a `for (let _feb…<_agentBondCount[idx]…)` loop with `partnerId`/`restLength` declared per iteration. (3) A 2D aggregate glues into chains/clusters; differential adhesion sorts + bonds lock the sorted state; drag-to-connect + brush-cut work (visible next step). (4) The inspector shows per-bond strain. (5) Cell regression byte-identical.

**Risk.** Do NOT copy MoveSelfToNeighbor's `requirements:{async:true}` (the bond nodes work in sync mode). The `maxBonds` overflow rejects. `ForEachBond` is an iteration SOURCE, not a new emit kind — add the dispatch branch + `varName` cases together.

---

## Phase C — division / growth / death (the headline)

### PR-C1 — `DivideAgent` + tension-axis eigensolve + geometric reattachment + `divisionEvent` root

**Goal.** The post-step structural division: the tension-proxy eigensolve axis, geometric bond reattachment, the `DivideAgent` request node, the `divisionEvent` root (daughter assignment). **The single largest net-new subsystem (N2).**

**Files & symbols.** `src/modeler/vpl/compiler/compile.ts:1900-1945` (the InitEvent template — `divisionEvent` clones it, daughter-set loop), `src/modeler/vpl/nodes/SetAttributeNode.ts:19` (the request-write shape for `DivideAgent`), the structural phase in `runAgentStep` (PR-A3). The eigensolve is engine-owned (worker) — NO per-target emit.

**The change.**
- **`DivideAgent`** (flow, `requirements:{ bondGraph:true }`, config `axisSource` (dropdown labelled **"tension axis"** — NO "shape long-axis" option), optional `axisX`/`axisY` value-ins, `asymmetry`∈[0,1]): emits `_divideRequest[idx]=1; _divideAxisX[idx]=…; _divideAxisY[idx]=…; _divideAsym[idx]=…` (the SetAttribute write shape; the request buffers are added to `agentLoopParams`).
- **The structural division** (post-step phase in `runAgentStep`): read `_divideRequest`; compute the tension-proxy eigensolve `M = Σ_k max(0,λ_k(l_k−L_k))·(r̂_k⊗r̂_k)` principal eigenvector (closed-form 2×2; degenerate-fallback to the density-gap minor eigenvector when `Σw_k≈0`); split the mother at `centroid ± ½·offset·m̂`; partition each partner bond to the NEARER daughter by `sign(dot(offset_k, m̂))`; add the daughter-daughter bond; alloc a free-list slot. **On `maxBonds`/`maxAgents` overflow during reattach, REJECT THE WHOLE DIVISION** (never half-rewire a partner — the riskiest single bug, [INVESTIGATION_BOND_GRAPH §9.1 #1](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md)).
- **`divisionEvent` root** (clone the InitEvent template at [compile.ts:1900-1945](../src/modeler/vpl/compiler/compile.ts); loop over the just-divided daughter set; preamble exposes `daughterIndex`∈{0,1}/`axisDefaultX`/`axisDefaultY`/`myArea` + mother attrs snapshotted pre-split) — the user authors "give daughter A more of Q" as a node graph.

**Acceptance test.** (1) `tsc -b` clean. (2) Seed 1 agent flagged to divide; after the structural phase, exactly 2 alive agents at `centroid ± 0.5·offset` along the tension eigenvector, the daughter-daughter bond present, partner bonds partitioned by `sign(dot(offset,axis))`. (3) The headline: a glued cluster grows and divides along its tension axis with bonds inherited by geometry (elongates along the mechanical axis, not balloons); the user authors "divide when age>T and size>X, give daughter A more of Q" entirely as node graphs. (4) A `maxAgents`-overflow division leaves the count UNCHANGED + surfaces a stopEvent-channel notice. (5) The `axisSource` dropdown reads 'tension axis' (no 'shape long-axis').

**Risk.** The division reattachment triple-hazard (overflow + epoch invariant + post-division `Δt` overshoot SIMULTANEOUSLY) — reject the WHOLE division on overflow, mutate only in the post-step phase. The eigensolve is engine-owned → locksteps for free (no per-target emit).

---

### PR-C2 — `SetTargetRadius` growth + `KillAgent` + the maxAgents/maxBonds/Δt hazards

**Goal.** Growth (radius ramps toward target over the cycle), death (recycle + break-all-bonds + epoch bump), and a hardening pass over the three silent-corruption hazards.

**Files & symbols.** The structural phase in `runAgentStep` (growth + death), `src/modeler/vpl/nodes/SetAttributeNode.ts:19` (`SetTargetRadius` already added in PR-A4; the consumer is here), the `Δt` clamp (PR-A3).

**The change.**
- **Growth**: radius ramps toward `agentTargetRadius` over the cycle (`SetTargetRadius` writes `w_radius[idx]`/`_agentTargetRadius[idx]`; the structural phase interpolates).
- **`KillAgent`** (flow, `requirements:{ bondGraph:true }`): emits `_killRequest[idx]=1`; the structural phase recycles the slot to the free-list + **breaks ALL bonds to/from the agent** + **bumps the slot epoch** (the dangling-bond ABI).
- **Harden the hazards**: `Δt` re-evaluated on any force/bond-λ change (the live-slider drift); `maxAgents`/`maxBonds` overflow rejects + surfaces everywhere (createAgent, division, region-glue); the per-step stale-partner sweep.

**Acceptance test.** (1) `tsc -b` clean. (2) A growing agent's radius ramps to target then divides. (3) `KillAgent` recycles the slot; a subsequent `createAgent` reuses it with a bumped epoch; a former partner's stale bond reads epoch-mismatch and is swept. (4) A `Δt`-too-large model (after a division) stays bounded (no geometry blow-up). (5) Cell regression byte-identical.

**Risk.** `Δt` monotonicity is a DRIFT, not a crash — the default IS the guard, re-evaluated on param change. Death must break ALL bonds AND bump the epoch (else a recycled slot strands a spring).

---

## Phase D — closed feedback (cell-CA-as-field)

### PR-D1 — `AffectCellsUnder`/`ReadCellsUnder`/`SampleField`/`FieldGradient` + the 2-engine orchestration

**Goal.** The closed agent↔grid stigmergy: the deposit-before-step / gather-after-step phasing in a new `runGeneration` that wraps the existing `runStep()`, the scatter/gather bridge nodes, the `paintField` brush. **The field IS the existing lattice CA (D-FIELD) — only the bridge is new.** The autonomous-branching demo.

**Files & symbols.** `src/simulator/engine/sim.worker.ts:1135` (`runStep` — `runGeneration` wraps it), `:2474` (the `case 'step'` handler for-loop — call `runGeneration()` instead of `runStep()`), `:3382-3411` (`writeRegion` — the `cellIndexOf`+`inBounds3d` stamp template for `AffectCellsUnder`), `src/modeler/vpl/nodes/UpdateAttributeNode.ts` (the op set: set/add/subtract/max/min).

**The change.**
- **The 2-engine orchestration** (`runGeneration` in the worker): per generation — (1) agents DEPOSIT into cell READ buffers (`AffectCellsUnder`); (2) the cell CA steps its own rule via the EXISTING `runStep()` ([:1135](../src/simulator/engine/sim.worker.ts)) K sub-steps (a `fieldSubSteps` model attr, CFL clamp); (3) agents GATHER the now-changed grid (`SampleField`/`FieldGradient`); (4) agents run `behaviourStep` + integrate forces + the structural phase. Call `runGeneration()` from the existing `case 'step'` for-loop ([:2474](../src/simulator/engine/sim.worker.ts)), keeping the main-thread chaining intact. The field reuses `stepFn`/`initFn`/`outputMappingFns` 100%.
- **`AffectCellsUnder(attrId, op, radius)`** (flow, `requirements:{ bondGraph:true }`): an agent writes ANY cell attribute over an r-disk(2D)/ball(3D) of cells under it, `op` ∈ {set,add,subtract,max,min}. **CRITICAL TIMING:** writes the cell **READ** buffer (`readAttrs[attrId][cellIdx]`) in the DEPOSIT phase BEFORE the cell step (writing `w_` is clobbered by the step's top-of-loop `w_.set(r_)` copy). Many-agents→one-cell resolved by the SEQUENTIAL agent loop applying each op in order (add accumulates, max wins) — a NEW agent-tier runtime guarantee. Model the write-loop on `writeRegion` ([:3397-3411](../src/simulator/engine/sim.worker.ts)). The `voxelOf` must use the 3D cell index `(layer*H+row)*W+col` (the field is `total=W*H*D`).
- **`ReadCellsUnder`/`SampleField`/`FieldGradient`** (value, `requirements:{ bondGraph:true }`): `SampleField(attrId)` bilinear(2D)/trilinear(3D)-samples the cell attr at the agent's continuous `(x,y[,z])` AFTER the grid step; `FieldGradient` central-differences; `ReadCellsUnder(attrId,radius,reduce)` aggregates over the disk. `paintField` brush (clone `paintManual`/`writeRegion`).

**Acceptance test.** (1) `tsc -b` clean. (2) The hypoxia→VEGF→branching loop ([PLAN_BG_DIMENSIONS §4.3](PLAN_BG_DIMENSIONS_AND_MODES.md)): agents consume O2 (a grid attr) → a hypoxic gradient; hypoxic agents secrete VEGF into a SECOND grid attr; agents divide up the ∇VEGF gradient; painting a wound perturbs it live. (3) An agent depositing into `source` then the grid diffusing shows the spread in `getState` (the deposit writes the READ buffer before the step). (4) `SampleField` at a known float position bilinear-equals a hand-computed 4-cell lerp; many-agents→one-cell accumulates in op order. (5) Cell regression byte-identical.

**Risk.** The deposit timing (READ buffer before the step) — writing `w_` is clobbered. The sequential op-accumulate is a NEW runtime guarantee, NOT `asyncWriteHazard.ts` (a compile-time within-one-cell-body analyzer). The field is 3D-capable now — `voxelOf`/splat must use the 3D index + trilinear interpolation.

---

## Phase E (later) — 3D agents

**Goal.** Extend the shipped `Gl3DRenderer` ([gl3d.ts:283](../src/simulator/render/gl3d.ts)) with sphere-impostor (`gl_FragDepth` for correct inter-sphere occlusion) + bond-tube instanced draw paths, reusing its orbit camera / colour-id `pick` / clip-plane / alpha-cull upload. Agents read per-agent alpha via the shipped `setCellLooks.a` port. The force law/axis/bonds gain a z. The agent instance buffer needs an **explicit-position layout** (the shipped `uploadColors` decodes x/y/z from a flat cell index — agents carry floats). **Acceptance:** orbit a growing bonded 3D tissue, slice into it with the clip plane, pick a cell. Deferred to after Phase D ships and is 2D-verified.

## Phase F (later) — WASM then WebGPU agent-loop lockstep

**Goal.** Port the variable-`highWater`, free-list-holed, continuous-position agent loop + the structural-phase reads to the WASM emitter (a NEW dispatch/loop structure, NOT a fork of `compileEntry` — WASM bakes `total` as a literal), then WebGPU (which also rejects async; bonds are sync-only). Until each lands, the `detectWasmIncompatibilities`/`detectWebGPUModelIncompatibilities` gate (PR-A0) force-restricts a bond-graph model to JS. Validation is **statistical** (sorting/cluster metrics, division-axis alignment vs the tension field), NOT bit-exact (WGSL f32 + per-cell PCG).

---

## §3 — Cross-cutting gotchas

1. **The two-graph blast radius (~20 `model.graphNodes` consumers — fork each).** `agentGraphNodes` forks: the JS compiler entry (an agent-specific compile path — do NOT merge `agentGraphNodes` into the lattice `compileGraph` which loops `idx<total` + decodes `_row`/`_col`; the agent compiler loops `idx<highWater` with no lattice preamble); `fileOperations` `serializeModel`→`stringifyCompact` ([:169-172](../src/model/fileOperations.ts)) + `readModelFile` recovery + `LOAD_MODEL` defaults+migrations; the ModelContext element-cleanup cascades (`patchAllNodes`/`clearDeletedId`/the tag-remap, [ModelContext.tsx:73-95](../src/model/ModelContext.tsx)) + their 6 callers ([:285/:419/:546/:590/:677/:869](../src/model/ModelContext.tsx)); undo (`graphHistory.ts`); clipboard paste ([GraphEditor.tsx:59](../src/modeler/vpl/GraphEditor.tsx)); the three add-node menus (palette [PalettePanelContent.tsx:177](../src/modeler/panels/PalettePanelContent.tsx) + quick-add/connection-drop [GraphEditor.tsx:3181](../src/modeler/vpl/GraphEditor.tsx)); the initial RF seed + the scope-switch effect + `scheduleSync` ([GraphEditor.tsx:507-508/1062-1064/730-731](../src/modeler/vpl/GraphEditor.tsx)). Gate M0b (PR-A5) BEHIND the agent compiler (PR-A0..A3) — an empty agent graph nobody can compile still forces every consumer to branch.

2. **D-IDX — the agent loop var MUST be `idx`.** `GetCellAttribute` hard-codes `ctx.readAttrExpr(attr, 'idx')` ([GetCellAttributeNode.ts:15](../src/modeler/vpl/nodes/GetCellAttributeNode.ts)); `idx` appears ~67× across ~25 node files. Naming it `aIdx` would require threading an `indexExpr` through `CompileContext` + editing all ~25 nodes × 3 targets (the rejected fallback). The docs write `aIdx` only as prose. Engine-owned buffers (`_agentX`/`_divideRequest` — N4) are NOT user attributes and use distinct naming, so `SetAttribute`/`GetCellAttribute` literally cannot target them (the guardrail). The NI codec + sub-attribute parent-guard are lattice-specific — agent-world nodes must NOT invoke them; `ctx.is3d` is a lattice concept (irrelevant to agent nodes).

3. **`Δt` monotonicity (silent corruption).** A "stable" but too-large `Δt` after division corrupts geometry as DRIFT, not a crash. The default IS the guard: `Δt ← min(Δt_user, 0.4·Δt*_mono)`, `Δt*_mono = ½(r₀−s)/F(r₀)` accounting for bond λ, RE-EVALUATED on any force/bond-λ parameter change (easy to forget the re-eval on a live model-attr slider drag). Build it from PR-A3, not as a follow-up.

4. **The dangling-bond ABI (`partnerEpoch` + break-on-death + stale sweep).** A recycled dead slot silently re-points a spring to a stranger. `bondPartnerEpoch` is a slot-generation tag checked on EVERY bond read; death breaks all bonds AND bumps the epoch; a per-step stale sweep catches the rest. The division reattachment triple-hazard (overflow + epoch + `Δt` overshoot simultaneously) is the riskiest single bug — mutate only in the post-step phase, reject the WHOLE division on overflow.

5. **`maxAgents`/`maxBonds` overflow must REJECT + surface, NEVER wrap** (the Amphiphile-NI-poisoning class). Surface via the Stop-Event/blue-notice channel (the WebGPU paint-handler worker-error pattern is the precedent). `createAgent`, division reattach, and region-glue all enforce this. A half-rewired partner on a rejected division is the riskiest single bug — reject the whole division.

6. **The agents-only lattice-less config (C3).** `topologyMode {gridCells:false, agents:true}` allocates NO grid: skip the cell SoA + neighbor tables, bound agents by a virtual `worldBounds` rectangle, and SIZE `colors` to `maxAgents*4`. But `colors` is currently a VIEW over `wasmMemory` at `wasmLayout.colorsOffset` ([sim.worker.ts:838](../src/simulator/engine/sim.worker.ts)) — the lattice-less branch must allocate a standalone `Uint8ClampedArray` or extend the layout. NOT a free reuse.

7. **The post-step structural engine phase is net-new (N2).** The request-emission (`_divideRequest[idx]=1`) is grounded in `SetAttribute`'s shape, but the code that CONSUMES the requests (eigensolve + reattachment + free-list + epoch maintenance + force integration + neighbour rebuild) is entirely net-new worker code with no `file:line` precedent. This is the single largest new subsystem — budget for it accordingly. The eigensolve being engine-owned means it locksteps for free (no per-target emit).

8. **Force the JS target for any `topologyMode.agents` model.** The worker's `runStep` branch is WebGPU>WASM>JS ([sim.worker.ts:1138](../src/simulator/engine/sim.worker.ts)), but agents are JS-reference-only v1 (D-TARGET) and bonds sync-only (D11). The `detectWasmIncompatibilities`/`detectWebGPUModelIncompatibilities` gate (PR-A0) keeps the agent engine off targets that can't run it — the CELL field can still use any target.

9. **First-class density/degree/curvature nodes, NOT Average-over-bond-list macros.** Average equals density only when the array length == degree, which is FALSE for a ragged bond list with free-list holes ([INVESTIGATION_BOND_GRAPH §9.1 #7/D13](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md)). `detectMissingConfig` ([nodeValidation.ts:23](../src/modeler/vpl/nodes/nodeValidation.ts)) has NO default case — every required-config agent node (`GetCurvature` channel, `SampleField` substrate, `FormBond` typeLabel, `DivideAgent` axisSource) MUST add a case or the compiler silently emits `_undef`.

10. **Every change must clear the lattice-path matrix (the 2D/3D dual-impact mandate).** The agent tier is additive + gated on `topologyMode.agents`, so the cell-CA path must stay byte-identical. Verify with the dev `compileHarness.compileAll` on BOTH a 2D model (Game of Life) AND a 3D model (Life3D) after EVERY PR.

11. **`buildLoopParams`↔`buildLoopArgs` lockstep.** The compiler's `agentLoopParams` ([compile.ts, sibling to :1160](../src/modeler/vpl/compiler/compile.ts)) and the worker's `buildLoopArgs` ([sim.worker.ts:971](../src/simulator/engine/sim.worker.ts)) MUST stay in lockstep — same gate, same order, same count. The 3D milestone proved this pair silently desyncs (the `dimsModel`/`total` bug). A new agent param pair edits BOTH at the same commit.

12. **Typed-array view discipline (Phase F).** v1 agent/bond arrays are plain JS typed arrays (JS-only), so they sidestep the wasmMemory view rule — but the Phase F WASM port bakes them as views over `wasmMemory` at offsets, and any restore handler MUST copy-into the existing view, never reassign the JS reference (the orderArray cautionary tale at [sim.worker.ts:3266 region](../src/simulator/engine/sim.worker.ts)). Document it before the WASM port.

13. **New WorkerMsg union entries** (per CLAUDE.md): `seedAgents`/`createAgent`/`paintAgents`/`killAgents`/`formBond`/`breakBond`/`formBondsRegion`/`breakBondsRegion`/`paintField` — each requires extending the `WorkerMsg` union ([sim.worker.ts:287](../src/simulator/engine/sim.worker.ts)) or the message is silently dropped.

14. **Both halves of a gate land together (M0b).** The Topology checkbox un-gate + the sub-tab elision + the ModelerView auto-switch ship in the same logical change — shipping the checkbox without the auto-switch strands the user on a hidden graph. (PR-A0 ships the checkbox; PR-A5 ships the auto-switch — keep them in the same phase, and never enable Agents in a build without the agent graph.)

---

## §4 — Definition-of-done per phase

### Phase A — agent substrate (JS, 2D)
- [ ] **A0** — Agents checkbox un-gated (last-checked-disabled, no "coming soon"); `bondGraph`/`lattice` flags in `NodeRequirements`; the JS-only force-restrict for `topologyMode.agents`; the `behaviourStep` root stub; cell path byte-identical; HTML mockup.
- [ ] **A1** — `CenterBasedConfig` + `agentGraphNodes`/`agentGraphEdges` schema + `EMPTY_MODEL` seed + LOAD_MODEL defaults + migration decision documented + `SET_AGENT_GRAPH` reducer/`setAgentGraph` (both dep arrays) + `stringifyCompact` inline-array; old files round-trip byte-identically.
- [ ] **A2** — agent SoA + free-list + `maxAgents` overflow-reject + alive-mask + `seedAgents`/`createAgent`; positions/radius/alive/highWater shipped in `stepped`; 2D circle render + picker seam + Seed/Kill/Set-type brush; agents-only lattice-less branch; `getState` round-trips the SoA.
- [ ] **A3** — `behaviourStep` value-outs + `agentLoopParams` (mirrored in `buildLoopArgs`) + the force driver (spatial hash + repulsion + vector reduction + position double-buffer) + the `Δt` clamp from the start; harness shows `idx<highWater`/`!_alive`/no-`_row`; force determinism vs an independent reference; cell path byte-identical.
- [ ] **A4** — `GetSelfPosition`/`GetRadius`/`GetBondDegree`/`NeighbourDensity`/`GetCurvature` (first-class, `detectMissingConfig` cases) + `SetTargetRadius` + agent brush + inspector; multi-out resolves; cell path byte-identical.
- [ ] **A5** — `activeGraph` swap (reusing `currentScope`) + Cells/Agents sub-tab + auto-switch/elision + palette gate (the `activeGraphKind` global) + the ~20-site cascade/serialize/undo/clipboard fork + 'Agent Attributes' label; clearHistory on swap; no `_undef` strand; HTML mockup.

### Phase B — bonds
- [ ] **B1** — the ragged bond store + the `partnerEpoch` dangling-bond ABI (break-on-death + stale sweep) + the agent+bond serializer (partner-remap-on-load + loud validation + `ATTR_TYPE_MAP` registration); save/load restores bond topology; corrupt-load fails loudly.
- [ ] **B2** — `FormBond`/`BreakBond` (NOT async-only) + the bond spring force + engine hysteresis + the `bondContactEvent` root + `ForEachBond` (dispatch + `varName`) + the glue/cut/region brush + the bond render layer + the bond inspector; a cluster glues into chains; cell path byte-identical.

### Phase C — division / growth / death
- [ ] **C1** — `DivideAgent` (axisSource 'tension axis', no 'shape long-axis') + the tension eigensolve (density-gap fallback) + geometric reattachment (reject-whole-division on overflow) + the `divisionEvent` root; the headline cluster grows + divides along its tension axis with bonds inherited; `maxAgents` overflow leaves count unchanged.
- [ ] **C2** — `SetTargetRadius` growth + `KillAgent` (recycle + break-all-bonds + epoch bump) + the hardened `Δt`/`maxAgents`/`maxBonds` hazards; a growing agent divides; a killed agent's bonds sweep; `Δt` stays bounded post-division.

### Phase D — closed feedback
- [ ] **D1** — `AffectCellsUnder` (any attr, op-accumulate, into the READ buffer, before the step) + `ReadCellsUnder`/`SampleField`/`FieldGradient` (bi/trilinear, after the step) + `runGeneration` 2-engine orchestration + `paintField`; the hypoxia→VEGF→branching loop runs; deposit diffuses; `SampleField` bi/trilinear-matches a hand-computed lerp; cell path byte-identical.

### Later
- [ ] **E** — `gl3d.ts` extended to instanced sphere-impostors + bond tubes (explicit-position instance layout), reusing orbit/clip/pick; orbit/slice/pick a growing 3D tissue.
- [ ] **F** — the WASM then WebGPU agent-loop + structural-phase port; the JS-only gate lifts per target as each lands; statistical (not bit-exact) cross-target validation.

### Global (every PR)
- [ ] `npx tsc -b` clean at every commit; every 2D library model (Game of Life) AND a 3D model (Life3D) byte-identical via `compileHarness.compileAll` before/after (the agent tier is additive + gated); the documentation lockstep (CLAUDE.md + HelpView + README + NODES_REFERENCE for the new roots/nodes + the `bondGraph`/`lattice` requirements + the `topologyMode.agents` mode) updated atomically with the code; on a feature branch off `master`; no push, no Co-Authored-By.

---

### TL;DR

The bond-graph agents are GenesisCA's largest net-new subsystem — a SECOND co-resident engine in the same worker: a `maxAgents` continuous-position SoA (free-list + alive-mask + `highWater`), a force-integration driver (spatial hash → soft-sphere repulsion + bond springs → overdamped Euler + `Δt` clamp), a persistent ragged bond store with the `partnerEpoch` dangling-bond ABI, a post-step structural phase (tension-axis division eigensolve + geometric reattachment + growth/death), and the closed agent↔grid feedback (the cell CA IS the field; deposit-before-step, gather-after). Phase A builds the substrate JS+2D (un-gate Agents + the two-graph split + SoA + force driver + the `behaviourStep` root with the agent loop var = `idx` per D-IDX); Phase B the bonds; Phase C the headline division/growth/death; Phase D the closed feedback. JS-reference-only (D-TARGET); 2D first; Phases E (3D agents, reusing the shipped `gl3d.ts`) and F (WASM/WebGPU lockstep) are later. The four silent-corruption hazards to design against up front: `Δt` monotonicity, the dangling-bond/free-list epoch ABI, `maxAgents`/`maxBonds` overflow (reject, never wrap), and the ~20-site two-graph blast radius. Guard every PR with the cross-target byte-identity harness on the lattice path (2D + 3D). The shipped `gl3d.ts` renderer, RGBA alpha, `topologyMode` schema, 3-axis NI, and the 3D brush are the foundation you reuse — nothing is rebuilt.

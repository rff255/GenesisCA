# Agent nodes — the catalogue and the per-node semantics

> Area doc for **GenesisCA**. What a rule can SAY on the Agents graph: the node catalogue, agent attributes vs agent variables, targeting (optional id ⇒ self), cross-agent write semantics, the neighbour density read, the Stop Event. Read before adding or changing an agent node.
>
> **Also read** — a change here usually reaches [`agent-engine.md`](agent-engine.md) · [`agent-compilers.md`](agent-compilers.md) · [`agent-capabilities.md`](agent-capabilities.md) · [`graph-rewriting.md`](graph-rewriting.md) · [`compiler-core.md`](compiler-core.md).
> Keep following those onward until a pass turns up nothing new; the reading is not done at the first
> doc that answers your question. See *Read to CLOSURE, not to the first hit* in `../../CLAUDE.md`.
>
> Sections below were moved **verbatim** out of `CLAUDE.md` (2026-09-06) so the always-loaded
> file could stay small. Nothing was rewritten or deleted. See `../../CLAUDE.md` for the
> project-wide rules and the routing table, and `docs/HANDOFF_*.md` for the full build narratives.
>
> **Paths here are repo-root-relative** (e.g. `src/model/types.ts`), exactly as they were in `CLAUDE.md`.
> Read them from the repository root; they will not resolve as links from this directory.

**Contents**

- Generic Agent Platform — separate agent attributes / variables + the comprehensive node catalogue (current)
- Agent polish round (branch `polish_agents`)
- Node catalogue (all `requirements: { bondGraph: true }`)
- Agent Stop Event (all 3 agent targets — branch `absorb_old_automatosgt`)
- Cross-Agent Write Semantics (branch `sim_agent_fixes`) — sync-overwrite gate + Apply Force To Agent
- Neighbour Density gains an optional Radius (all 3 agent targets — branch `tasks_batch_2026_08`)
- Agent action TARGETING — optional id, default self (branch `polishing`)

---

## Bond-Graph Agents — Floating Cells (milestone, branch `agents_floating_cells`)

*(continued from `CLAUDE.md`; other parts of this milestone live in sibling area docs.)*

### Generic Agent Platform — separate agent attributes / variables + the comprehensive node catalogue (current)
Agents are now first-class authorable entities with their OWN state, NOT a reuse of the cell attribute set. **This SUPERSEDES the old "cell attrs DOUBLE as agent attrs" framing.**
- **Agent attributes** — a parallel `CAModel.agentAttributes?: Attribute[]` (agent-only per-agent state, a SEPARATE id-space). The agent SoA + the own-agent channel `r_<id>`/`w_<id>` (behaviour/division loops) are keyed by these via **`agentAttrsOf`** ([src/model/attributeScope.ts](src/model/attributeScope.ts), the single source of truth: `agentAttrsOf` / `cellAttrsOf` / `cellFieldAttrsOf` / `cellFieldWriteAttrsOf`). On the Agents tab the Attributes panel lists `agentAttributes` with its own +Add (ADD/UPDATE/REMOVE_AGENT_ATTRIBUTE reducers); Get/Set/Update Attribute + Get Agent Attribute resolve their dropdown against `agentAttrsOf` (graph-aware via `getActiveGraphKind()`). **Master-detail wiring (bug-fixed):** `AttributesPanelContent` already auto-selects a new agent attr on +Add and resolves the `mode='detail'` editor against `agentAttributes`, but `ModelerView.selectedItemName` (which GATES the second detail PanelShell's visibility via `detailItemName != null`) resolved `attr:<id>` ONLY against `model.attributes` — so an agent-attribute selection returned null and the editor never mounted (creating OR clicking an agent attr did nothing). Fixed by making `selectedItemName` graph-kind-aware: `ModelerView` subscribes to `getActiveGraphKind` and, when the Agents tab is active (`attrAgentMode`), resolves `attr:` against `agentAttributes` THEN the shared MODEL attributes (`isModelAttribute` — a cell attr, not listed on the Agents tab, must NOT resolve there) and `var:` against `agentVariables`. Verified in-app: selecting `alive` and +Add both open the detail editor on the Agents tab.
- **Cell-attribute agent-access permission** — `Attribute.agentAccess?: 'none'|'read'|'readWrite'` on CELL attributes gates the field bridge: `_field_<id>` is threaded ONLY for `cellFieldAttrsOf` (agentAccess !== 'none'); field READ nodes (sampleField/fieldGradient/readCellsUnder) require read, field WRITE nodes (affectCellsUnder/secreteToField) require readWrite. CA cells can NEVER read agent attributes (structural — the cell compilers never see `agentAttributes`). Edited via the "Agent access" control in the cell-attribute detail editor.
- **Agent variables** — a parallel `CAModel.agentVariables?: Variable[]`; `buildVariableJS(variables)` takes a list (cell sites pass `model.variables`, agent sites pass `model.agentVariables`); the variable reducer actions carry `target: 'cell'|'agent'`. The agent-WASM array-var gate reads `agentVariables` (the false-positive fix). The JS compiler's **`sourceYieldsArray`** (which decides array-pass-through vs `[_v]`-wrap when a value feeds an `isArray` input like Get Array Element / Array Length / Aggregate) must ALSO look up BOTH scopes — without the `agentVariables` arm an agent Local-Variable ARRAY was mis-classified as a scalar and wrapped as `[_v]`, so `arrayElement[0]` returned the WHOLE array and `arrayElement[≥1]` returned 0 (`[_v].length===1`), silently corrupting read-modify-write accumulators (e.g. a per-agent force-accumulation loop). Fixed to search `variables` then `agentVariables` (ids are globally unique → unambiguous).
- **Migrations** ([agentAttributeSplitMigration.ts](src/model/agentAttributeSplitMigration.ts) + [variableScopeMigration.ts](src/model/variableScopeMigration.ts), LOAD_MODEL): legacy agent models stored agent state in cell attributes/variables. The split migrations MOVE any cell attr/var referenced as agent state by the agent graph into `agentAttributes`/`agentVariables` (DUPLICATE if also cell-referenced); a cell attr used as a FIELD stays a cell attr + gets `agentAccess`. Idempotent (skip when the agent set is non-empty). Verified: Tissue→agentAttributes=[maturity]; Chemotaxis→chemical stays a cell field (readWrite); Boids→accumulators move to agentVariables; lattice byte-identity preserved.
- **ABI-mirror discipline** — `buildAgentLoopParams`↔`buildAgentLoopArgs` and `buildDivisionParams`↔`buildDivisionArgs` both derive `r_`/`w_` from `agentAttrsOf` and `_field_` from `cellFieldAttrsOf`/the worker's `fieldSpecs` (a separate ordered list from the agent `attrSpecs`); `_lookupTables` rides a pinned slot (after glyphColors, before the field block) gated on the model having a lookupTable model attr. The worker's `buildAgentAttrSpecs` maps `agentAttrs` (from the init message's `agentAttributes`), and `computeAgentMemoryLayout` + the agent-WASM spec derive from the same `agentAttrsOf` list (the baked-offset lockstep).
- **Universal-node agent-compile fixes** (`compileAgentGraph` ran none of the cell pre-resolves): now runs the indicator-index pre-resolve, the Stop Event `_stopIdx`/`stopMessages` collection (offset by the cell stop count — shared `_stopFlag`), and the Set Cell Looks `_isV_` viewer-hoist into the behaviour + division preambles, over `agentGraphNodes`. Accessor-CSE is gated OFF in async agent mode (`agentUpdateMode` default 'async').
- **Comprehensive agent node catalogue** (new `bondGraph` nodes, JS-only — clones of the lattice array ops with the NeighborIndex codec removed: integer agent ids, `-1` empty sentinel, reading the agent SoA at `r_<attr>[id]`): **Get Bonded Agents** (this agent's bonded partners → id[], the data sibling of For Each Bond), **Filter Agents** / **Join Agents** (multi-output result+count over id arrays), **Pick Random Agent** / **Pick N Random Agents** (shared `_rs`), **Get Agents Attribute** (the keystone gather: one attr over an id array → values[], for Aggregate/Group Counting), **Set Agents Attribute** (write-many), **Set Velocity** (writes `_agentVX/VY[idx]`; needs momentum>0). Registered like the lattice array producers (scratch `_v<id>_result`/`_vals`/`_work`, `varName`, MULTI_OUTPUT for filter/join, NEVER_INVARIANT + NEVER_PURE). Excluded from `AGENT_WASM_SUPPORTED_TYPES` so a graph using one clamps to JS. Plan: [docs/PLAN_GENERIC_AGENT_PLATFORM.md](docs/PLAN_GENERIC_AGENT_PLATFORM.md).
- **Graph-authored agent spawning + the Agent Init Event (DONE — PR4):** a once-only **`agentInit`** entry-point (runs ONCE on first load AND on Reset, before the first behaviour step — the agent analogue of the cell Init Event) whose `DO` chain the user loops over to spawn agents. **`createAgent`** (multi-output: `x`/`y`[/`z` in 3D]/`radius` inputs → a `handle` id; compiles to `const _v<id>_handle = _agentCreate(x, y[, z], radius)` — the `type` input was **REMOVED**) stages a slot at `alive=0`; **`addAgentToWorld`** (`handle` input) commits it (`alive=1`, `liveCount++`); a leak-sweep frees any Created-but-not-Added slot at the end of init. **`setAgentPosition`/`setAgentRadius`** + a `setAttribute` with its `Agent` id wired retarget a staged handle (the `setAgentType` node was **DELETED** with the built-in `type`) (the setters relax their range guard to `< _agentMaxAgents` when `ctx.agentRoot==='init'`, since the staged slot isn't yet `alive`). `buildAgentInitParams`↔`buildAgentInitArgs` mirror (leads with `_agentCreate,_agentAddToWorld,_agentMaxAgents`). `agentInit`+`createAgent` are in `MULTI_OUTPUT_TYPES`. The worker's `runAgentInit` closures `_agentCreate`=allocAgentSlot+initAgentSlot(stage alive=0) / `_agentAddToWorld`=alive=1; overflow (maxAgents) surfaces an `agentOverflow` notice (never wraps). **Two engine fixes the samples surfaced:** (1) the **cell Init Event now runs on first load** too (worker `init` handler calls `runInit()` after `initGrid` applied defaults — BEFORE the agent Init Event so a Create-Agent rule that reads the field sees the seeded substrate), so a procedural-init model shows its state on load instead of a blank grid until Reset; an embedded `simulationState` still wins (pendingSimStateRestore overwrites after the first step — verified on Amphiphile). (2) **sync agent mode** (`agentUpdateMode:'sync'`) double-buffers the agent attrs, so `runAgentInit` copies `attrWrite→attrRead` after the init (the init's Set-Agent-Attribute wrote the write buffer; the first step + getState read the read buffer) — without it a sync model loads with all-default agent state.
- **RNG-in-loop hoist fix (sinkAnalysis):** `hoistPastLoops` would hoist an RNG node (`getRandom` / `pickRandom*` / `groupOperator|aggregate` random/weightedRandom) OUT of a Loop/ForEach body, so a spawn loop that randomises each agent gave every agent the SAME value (computed once). `isLoopPinned(nodeId)` (a backward closure: self-or-any-value-input is RNG) keeps such values per-iteration. Lattice byte-identical (only relocates RNG emission, and only when an RNG value sits inside a loop body). Verified: 64-agent spawn grid → per-agent random state 31/64; standard lattice models compile clean.
- **Two shipped samples (PR5):** **Game of Life on Agents** ([scripts/gen-gol-agents.mjs](scripts/gen-gol-agents.mjs)) — the GENERICITY PROOF: Conway's GoL on a 32×32 grid of agents spawned by the Agent Init Event, the totalistic rule via Get Nearby Agents → Get Agents Attribute → Aggregate(sum) → Compare/Logic, SYNC agent update, `customForcesOnly`+momentum 0 (pinned grid). Verified: alive count evolves (318→…→stabilising still-lifes/blinkers), renders as green/dark circles. **Ant Necrophoresis** ([scripts/gen-ant-necrophoresis.mjs](scripts/gen-ant-necrophoresis.mjs)) — STIGMERGY via the closed field bridge, DISCRETE and EXACTLY MASS-CONSERVING (rebuilt 2026-07-28; the first version was a non-conservative decimal-density smear that manufactured corpses). See the "Ant Necrophoresis" section under Library Models below for the full design.
- **Recording/screenshot capture agents:** SimulatorView's recording + screenshot paths read the DISPLAY canvas (`canvasRef`, where `drawAgentsOverlay` paints) — not the grid-resolution `srcCanvas` — when `isAgentModelRef.current`, so GIF/WebM/PNG export includes the agent overlay. **Recording capture MUST NOT `getImageData` a LIVE canvas directly** — that flags it `willReadFrequently` and de-optimizes it out of GPU acceleration, so that canvas's drawing stays **~6× slower even after recording stops** (MEASURED: 150 blits 33 ms → 204 ms, persistent) — the reported "records fine then grinds to a halt and never recovers" bug. This bites TWO live canvases, and they were fixed in two rounds: (1) the **display canvas** (agent-overlay path) — the agent 2D capture `drawImage`s the display onto a dedicated CPU-backed **`recordScratchRef`** (`getContext('2d', { willReadFrequently: true })`, a texture READ that leaves the display fast; a controlled experiment confirmed `drawImage`-to-a-CPU-scratch does NOT de-opt the source, ~1×) then `getImageData`s the scratch, DOWNSCALED to a `RECORD_MAX`(960)px long axis so window-sized frames don't thrash GC; (2) the **`srcCanvas`** (non-agent path) — the OLD code `getImageData`'d `srcCanvasRef` every frame, but `srcCanvas` is the LIVE **blit source** (`drawImage(srcCanvas → display)` each frame), so that de-opt permanently slowed EVERY blit — the persistent slowdown that survived round 1 on general (non-agent) models. The fix builds the frame straight from the worker's **`colorsRef.current`** grid-colours buffer (the same pixels `putImageData`'d into `srcCanvas`) via `new ImageData(copy, w, h)` — **reading no canvas at all** — for BOTH WebGPU direct render AND JS/WASM; the only `srcCanvas` fallback (colors buffer absent) also routes through the scratch, never `getImageData` on the live `srcCanvas`. Verified at runtime: a 12-frame recording of a non-agent model does **0** `getImageData` calls (spy-confirmed the spy catches deliberate reads). (All 2D capture branches feed the same `recordedFrames` buffer used by the GIF + WebM encoders; the 3D branch uses the GL canvas `readPixels`, which doesn't have the Canvas2D de-opt problem. `recordedFrames.current` is cleared after every encode.) **Screenshots keep all readbacks off the live display too**: the agent-model `handleScreenshot` branch now `drawImage`s the display onto a throwaway offscreen and `toBlob`s THAT (matching the 3D + direct-render branches), so no screenshot branch reads the persistent display canvas. NB `toBlob`/`toDataURL` do NOT trigger the de-opt (measured: `toBlob` ×3 on a visible canvas = 1.07× vs `getImageData` ×3 = 1.8×) — the willReadFrequently demotion is **`getImageData`-specific** — so this is consistency/hardening, not a perf bug. (Empirically also ruled out as causes of the "load then record" slowdown: worker leaks [net 0 live workers over loads], window/doc listener leaks [0 net growth], WebGL context accumulation [1 live GL canvas over 6 loads]; `srcCanvasRef` is nulled on reinit so its de-opt never crossed loads.)
- **Doc sweep DONE:** HelpView (corrected the obsolete "cell attrs double as agent attrs" framing → separate Agent Attributes + the cell-attr Agent-access permission; added Working-with-Sets-of-Agents + Spawning sections), README (agent platform + the two samples), `docs/NODES_REFERENCE.md` (**107** selectable node types / **39** agent nodes — matches `getAllNodeDefs().length===110` minus 3 hidden macro nodes; the removed `setAgentType` dropped both counts by 1).
- **Adversarial-review hardening (2 fixes):** (1) `getAgentsAttribute` now skips empty(-1)/out-of-range/dead ids in its gather loop (mirrors `setAgentsAttribute`'s guard) — a hand-built id array with a `-1`/dead id no longer pushes `undefined` and poisons a downstream Aggregate to `NaN` (engine-produced arrays were already clean, so GoL-on-agents is byte-unchanged — re-verified it still evolves). (2) `compileAgentFns` now posts an error on an Agent-Init-Event compile failure (was silently `agentInitFn=null`) AND the DEV ABI-arity assertion covers the **third** pair `buildAgentInitParams↔buildAgentInitArgs` (was only behaviour+division). The review confirmed all three ABI pairs match slot-for-slot, every multi-output/scratch node has its `varName`+scratch registration, all required configs have a `nodeValidation` case, and the staged-slot guard relaxes ONLY under `ctx.agentRoot==='init'`.
- **Unified spawning — Create Agent + Add Agent To World work in the BEHAVIOUR graph too (not just Init), the one-idiom "bird lays an egg" model (branch `absorb_old_automatosgt`).** Retired the request-based Spawn Agent / Spawn Event dichotomy (committed then reverted, `747f68c`→`c3ff7ca`) in favour of ONE idiom: exactly as `Set Attribute` works in both the Init Event and the Generation Step, `Create Agent → set-by-handle → Add Agent To World` now works in both the Agent Init Event and the Behaviour Step, with full direct control over the new instance (set any attribute / position / radius / form bonds on the handle). The loop ABI ([agentAbi.ts](src/modeler/vpl/compiler/agentAbi.ts) `'loop'` kind) gained the SAME `_agentCreate`/`_agentAddToWorld`/`_agentMaxAgents` the `'init'` kind leads with; `buildAgentLoopArgs` supplies the closures (safe no-op defaults for the colour-pass / arity-assert call sites). The worker's `runAgentStep` builds **GROW-ONLY** closures (a mid-step Create appends at `highWater`, never reuses a free-list hole that could sit ahead of the loop cursor → the newborn is beyond the fixed loop bound, so it is fully configured THIS step but runs its own behaviour NEXT step — the intuitive newborn semantics, matching Init) + a leak-sweep of any Created-but-not-Added slot. The by-id setters (a wired `setAttribute`/`setAgentPosition`/`setAgentRadius`/`setAgentSprite`) relax their range guard to `< _agentMaxAgents` in the **behaviour** root too (a staged handle is `alive=0`; writing a dead slot is a harmless no-op). Overflow past `maxAgents` → handle `-1` → downstream Set/Add no-op. Plan+mockup: [docs/PLAN_UNIFIED_AGENT_SPAWN.md](docs/PLAN_UNIFIED_AGENT_SPAWN.md)/`.html`. **Verified end-to-end on ALL THREE agent targets (JS, WASM, WebGPU) through the real worker** (a bird whose behaviour Creates an egg at myX+3, sets the egg's `tag=99`+`hasSpawned` on the handle, Adds it → the egg exists next step at the right position with the right attrs, the newborn didn't move/behave the step it was born, bounded, 0 errors; overflow rejects cleanly; ABI test + parity + samples unregressed). **WASM DONE:** `createAgent`/`addAgentToWorld` are in `AGENT_WASM_SUPPORTED_TYPES` with emitters that call two NEW host imports `env.agentCreate` (funcIdx 8, `(f64,f64,f64,f64)->i32`) + `env.agentAddToWorld` (funcIdx 9) — the SAME grow-only closures the JS behaviour uses (hoisted to worker module scope so the once-bound imports share them → bit-identical); the WASM by-id setter guard (`emitGuardedAgentWrite`) relaxed to range-only (`< layout.maxAgents`); the WASM force pass iterates `hw` (pre-spawn) so a newborn isn't force-integrated the step it's born. **WebGPU DONE (all-target complete):** the parallel GPU can't call the CPU closures mid-shader, so `createAgent` is an **atomic bump allocator** — `atomicAdd(&spawnCursor, 1u)` into a NEW read_write storage buffer (binding 12; the Control uniform is read-only so the counter can't live there), returning that real slot as the `handle` so the by-id setters write the newborn directly. `agentAlive` (binding 2) is made `read_write` when spawning so `addAgentToWorld` marks the slot live (`agentAlive[handle]=1u`); createAgent writes the child's x/xNext/y/yNext[/z/zNext]/radius/targetRadius + zeros vx/vy[/vz]/age + **resets the child's agent attrs to their compile-time defaults** (`encodeAttrValue` per attr — the GPU analogue of `initAgentSlot`, which never runs GPU-side), then a Set Attribute by handle overrides exactly like JS. The by-id setter guards (a wired `setAttribute`/`setAgentPosition`/`setAgentRadius`) relax to range-only (`< control.maxAgents`, no alive check — the WebGPU compiler only ever emits the behaviour graph, so this matches the JS behaviour relaxation). The runtime seeds `spawnCursor = highWater` before each dispatch (`uploadAgentSpawnCursor`) and `readbackAgentStep` **reconciles** the newborns in `[oldHighWater, cursor)`: committed (alive) slots become live agents via `initAgentSlot` + the GPU-read attrs (bump `liveCount`/`highWater`); staged-not-committed slots go to the free-list (`freeStagedSlot`); `cursor > maxAgents` surfaces an `agentOverflow` notice (capped, never corrupts). All gated on the compiler's `usesSpawn` flag (threaded compiler result → SimulatorView → worker → `createAgentWebGPURuntime`) so a NON-spawn agent shader is byte-identical (no binding 12, `agentAlive` read-only). **Verified on the real GPU** (3 birds → 6 agents at the right positions/attrs, bounded across steps; 50-bird overflow caps at 64 with the notice; Boids/non-spawn shaders unregressed, 0 device errors). `git diff --stat` touches ONLY `agentWebgpu/compile.ts` + `agentWebgpuRuntime.ts` + the gated `sim.worker.ts`/`SimulatorView.tsx` branches → lattice grid + JS/WASM-agent byte-identical by construction.
- **Known limitation (context footgun):** placing a per-agent reader (`getSelfPosition`/`getNearbyAgents`/`setVelocity`/…) inside the Agent Init Event emits code referencing an undefined `idx` and the fn fails to compile — now surfaced as a clear `[agents] init compile failed: <var> is not defined` worker error (no modeler badge yet; a context-aware badge would need flow-root tracing in `nodeValidation`). (`createAgent`/`addAgentToWorld` in the behaviour graph now WORK — see the unified-spawning bullet above.)
- **STILL TODO (planned, not yet built):** the macro-availability gate (D-MACRO-AVAIL); a flow-root-context `nodeValidation` badge for the init-vs-behaviour footgun above. (The agent-WASM emit for the PR3/PR4 nodes is now DONE — the WHOLE catalogue runs on WASM with JS bit-parity; see "Phase F — WASM AGENT WHOLE-TARGET PORT".)

### Agent polish round (branch `polish_agents`)
A breadth pass tightening the generalist agent model. Lattice (2D+3D, all 3 targets) + every non-agent model byte-identical (all additive/gated). JS↔WASM bit-parity re-verified on all 8 agent samples.
- **Built-in agent `type` REMOVED end-to-end.** It didn't fit the generalist intent — agents carry ONLY user-defined `agentAttributes`. Removed: the `type` Int32 from the agent SoA (`AGENT_I32_FIELDS` in agentEngine.ts) + `AgentStore.type` + `initAgentSlot`'s type param + `seedAgents`/`AgentSeedSpec.type` + the render-snapshot / serialize-deserialize `type`; the per-type `AGENT_PALETTE`/`defaultAgentColor` → a single neutral `DEFAULT_AGENT_COLOR` (cyan `[76,201,240]`); `createAgent`'s `Type` input + `behaviourStep`'s `myType` output; `_agentType` from all three agent ABIs (`buildAgentLoopParams`/`buildDivisionParams`/`buildAgentInitParams` + the worker arg builders) and from WASM (`AGENT_WASM_SUPPORTED_TYPES`, the layout i32 `type` slot, the myType/setAgentType emit) + WebGPU (`AGENT_GPU_I32_FIELDS`, the myType/setAgentType emit, the i32 readback). The **`setAgentType` NODE is DELETED** (registry + node file). Migration [agentTypeRemovalMigration.ts](src/model/agentTypeRemovalMigration.ts) (LOAD_MODEL + macroImport + the dev harness) strips legacy `setAgentType` nodes, `createAgent` `_port_type`, and `behaviourStep` `myType` edges so old `.gcaproj` files load clean. Agents are now coloured by Set Cell Looks (behaviour) OR by Agent Output Mappings (below).
- **maxBonds may now be 0** (the pure-force / charged-particle case — agents with no bonds). Shared resolver **`resolveMaxBonds(cfg)`** ([centerBased.ts](src/model/centerBased.ts)) floors at **0** (not 1), used by `createAgentStore` + the WASM agent compiler so the worker store + the baked WASM offsets agree at maxBonds=0 (the bond store collapses to zero bytes). `defaultCenterBasedConfig` now seeds `maxBonds:0` (bonding physics off by default); the Properties "Max Bonds / Agent" field min is 0, and enabling "Use bonding physics" bumps it to the default if still 0. (The soft-sphere force was already gated on `usesBondingPhysics` via `engineForces = bonding`, so a `useBondingPhysics:false` model already skipped ALL engine forces.)
- **3D coordinates on every agent position/force/velocity node.** In a 3D-agent model these now expose a Z input/output, **hidden in 2D via `hiddenPorts(is3dModelLike)`** so 2D is byte-identical: Create Agent (Z input → `_agentCreate(x,y,z,radius)`), Set Agent Position (Z), Get Agent Position (Z output), Apply Force (Force Z), Set Velocity (Vz), Agent Init Event (World Depth output). Wired through JS (+ WASM/WebGPU where the z arm already existed — `setAgentPosition` got the WASM z write). (`getSelfPosition`/`getVelocity`/`getAgentOffset`/`fieldGradient`/`behaviourStep` myZ/`divisionEvent`/`divideAgent` were already 3D-aware.)
- **Palette filtering + agent self-attribute labels.** `LATTICE_ONLY_TYPES` ([nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts)) gained `moveSelfToNeighbor` + the variegated orientation/facing nodes (`getOrientation`/`setOrientation`/`getFacingOrientation`/`setFacingOrientation`/`getNeighborOrientationByIndex`/`setNeighborOrientationByIndex`/`getFacingLabels`/`getAllFacingLabels`/`interactionTableMap`) so a 2D grid+agents+variegation model no longer surfaces them on the Agents sub-tab. New `NodeTypeDef.agentLabel`/`agentDescription` + `displayNodeLabel`/`displayNodeDescription` ([graphState.ts](src/modeler/vpl/graphState.ts)): universal Get/Set/Update Attribute read as **"Get/Set/Update Self Attribute"** on the Agents graph (wired through CaNode, the Palette, the quick-add / connection-drop menu, and NodeExplorer).
- **Mode-responsive Properties panel** *(SUPERSEDED by the four-sub-tab refactor — see "Properties panel — four sub-tabs + an Indicators tab"; kept as history)* ([PropertiesPanelContent.tsx](src/modeler/panels/PropertiesPanelContent.tsx)): Variegated Cells moved OUT of the Execution block into its OWN section placed LAST (after the common Indicators / End Conditions) and hidden entirely for an agents-only model; the cell-grid execution controls (the GRID's Update Mode + Compile Target) are hidden for an agents-only model (no lattice). New section order: Structure → Execution → Indicators → End Conditions → Variegated.
- **Agent perf independent of world size + CA-grid-disable** ([agentEngine.ts](src/simulator/engine/agentEngine.ts) + [sim.worker.ts](src/simulator/engine/sim.worker.ts)). `buildSpatialHash` is now **bbox-anchored on a BOUNDED world** (the hash grid anchors to the agents' bounding box, so the bin count + per-step cost track the agents' SPREAD, not the world size). **TORUS keeps origin `(0,0,0)`** but coarsens the bin edge so the bin count is capped at **`AGENT_HASH_BIN_CAP` (65536)** — constant per-step cost regardless of world size. The grid ORIGIN (0 on a torus → byte-identical) threads through JS/WASM/WebGPU (behaviour + force pass + getNearbyAgents / auto-bond bin math + the Control/ForceControl uniforms); `computeAgentMaxHashBins`'s reserve is now `min(worldBins, cap)` (no MB-scale blowup as the volume scales up). Separately, when **`topologyMode.gridCells` is OFF** (agents-only) the worker skips `buildNeighborIndices` + the cell step + the colour pass (threaded via the init message's new `gridCells` field; toggling it reinits).
  - **THE BIN EDGE TRACKS THE QUERY RADIUS, which is why a TREE does not beat this hash for GenesisCA's models** (C11, measured — [docs/INVESTIGATION_ADAPTIVE_INDEX.md](docs/INVESTIGATION_ADAPTIVE_INDEX.md), reproduce with `node scripts/bench-spatial-index.mjs`). The worker builds ONE hash per generation at `max(interactionRange·2·maxR, neighbourQueryRadius, chargeBinEdgeOf(cfg))`, so the 3×3(×3) stencil always spans ≥ 3r and the over-scan is a **CONSTANT ≈2.9× in 2D / ≈6.4× in 3D, independent of r/spacing** — the mechanism by which trees normally overtake a *fixed*-bin hash simply is not present. Measured against an exact bbox-pruned range query over C10's octree (identical neighbour sets, asserted): the hash wins or ties out to **r/spacing ≈ 5** and only loses past **≈10**, while **no shipped model exceeds r/spacing = 3.27**. The tree's ≥1.5× wins live in two regimes no shipped model occupies — a radius large relative to spacing, and a TORUS world wide enough (> ~256 bins/axis) for the **`AGENT_HASH_BIN_CAP`** coarsening to float the edge above the query radius (there it reaches 10×). ⇒ **the adaptive index was NOT shipped**; the retry preconditions are in the investigation doc. NB the realised speedup is consistently far below the candidate-count advantage (9.6× candidates → 2.0× time), so a traversal's bookkeeping eats most of its algorithmic edge.
  - **THE ONE REAL LOSS THE MEASUREMENT FOUND — a hash that CANNOT BUILD runs ALL-PAIRS, silently.** `buildSpatialHash` returns `null` when the world is under **3 bins wide on any axis** at the bin edge (correct — a wrapping 3-wide stencil would visit a bin twice and double-count) and every emitted query then takes its all-pairs fallback. `computeResidentHashParams` ([agentWebgpuRuntime.ts](src/simulator/engine/agentWebgpuRuntime.ts)) carries the SAME rule, so the GPU-resident batch bails identically. **The shipped `Particle Life 3D` sits exactly here**: a 160×110×70 torus with `neighbourQueryRadius: 24` admits `floor(70/24) = 2` bins in z ⇒ 6×4×2 ⇒ all-pairs on every target, every generation (measured 43.6 ms vs 5.5 ms of queries at its N=1200; lowering `neighbourQueryRadius` to the 16 its graph actually queries with makes the hash build — 240 bins of 16.0, verified in-app). **The shipped model was deliberately NOT retuned.** C11 surfaced it instead: `getDiagnostics` gained a **`spatialIndex`** block recorded AT THE BUILD SITES (`noteAgentHash` for both `buildSpatialHash` calls **plus an equivalent record in the resident batch, which builds its hash GPU-side and never reaches that function** — the trap a first version fell into), and the C3 diagnostics popover shows an **Agent neighbour index** row reading either `spatial hash, N bins of E` or the all-pairs reason + which setting dominates the edge. Deliberately NOT a toast: an all-pairs index is harmless on a small model, so the passive P4 surface is the honest placement.
- **Agent Output Mappings** (the headline — agents get their OWN Attribute→Color VIEWS). New schema field **`CAModel.agentMappings?: Mapping[]`** (linked A→C over `agentAttributes` — pick an agent attribute → colour instead of hand-wiring Set Cell Looks in the Behaviour Step). New [agentLinkedOutputMappings.ts](src/modeler/vpl/compiler/agentLinkedOutputMappings.ts) synthesizes a per-mapping colour-pass graph (`getCellAttribute`[agentAttr] → `colorScale`/`categoricalColor` → `setCellLooks`), reusing the cell linked-OM helpers — **no per-target colour math**. `compileAgentGraph` compiles each into a per-agent colour-pass fn (returned as `outputMappingCodes`) looping the agent SoA writing `s.colors`. The worker's **`runAgentColorPass`** (was a stub) runs the fn matching the active agent viewer (with `activeViewer` overridden to the mapping id), recolouring before each snapshot + on mutations; `agentColorViewer` threaded via init/recompile/colorPass. **The agent colour pass runs in JS on the worker regardless of the agent compile target** (it only reads `s.attrRead` + writes `s.colors`). The simulator's viewer control is a **TWO-LAYER selection** — a "Cells (A→C)" group + an "Agents (A→C)" group when both layers have mappings (`activeAgentViewer` state). (It was a two-ROW top bar until 2026-09-07; the choice now rides the transport bar between `G/F` and play — see [simulator-ui.md](simulator-ui.md) *The VIEWER CONTROL*. The selection semantics did not change.) The Mappings panel has an "Agent Output Mappings" section (inline pick attribute→colour, reusing the parametrized `LinkedOutputEditor` over agentAttributes). ModelContext: `ADD/REMOVE/UPDATE_AGENT_MAPPING` + LOAD_MODEL seed + an unlink cascade when the linked agent attribute is removed.

### Node catalogue (all `requirements: { bondGraph: true }`)
- **Event roots**: `behaviourStep` (per-agent update; value-outs `myX`/`myY`[/`myZ` in 3D]/`myRadius`/`myArea`/`myBondDegree`/`myAge` — the `myType` output was **REMOVED** with the built-in agent `type`), `divisionEvent` (per-daughter assignment; `daughterIndex`/`axisDefaultX`/`axisDefaultY`/`myArea`).
- **Self reads** (`data`): `getSelfPosition` (multi-out X/Y), `getRadius`, `getBondDegree`, `neighbourDensity` (first-class engine reductions, NOT Average-over-bond-list; density also takes an optional Radius that LOWERS it to a fresh absolute-radius count — see its own section), `getVelocity` (Vx/Vy — self if Agent unwired, else a neighbour's), `getCurvature` (mean unit-vector magnitude to bonded partners, 0=flat/interior →1=convex edge/tip; <2 bonds → 0), `sampleField`/`fieldGradient`/`readCellsUnder` (the field-bridge reads).
- **Neighbour access** (`data`, the boids/tissue-interaction unlock): `getNearbyAgents` (radius → an agent-id ARRAY queried against the spatial hash; iterate with For Each In Array), `getAgentPosition` (a specific agent's X/Y[/Z] by id, with an absolute/relative **`mode`** [config, default `'absolute'`]: **absolute** = the RAW position [field seeding]; **relative** = the torus-SHORTEST displacement `target − reference` folded like the engine, via a new `refId` input that **DEFAULTS to self (`idx`)** when unwired — so it covers "vector to a neighbour" out of the box AND generalises to the offset between ANY two agents. `hiddenPorts` shows `refId` only in relative mode + `z` only in 3D. Relative mode = `compileAgentOffset` minus the Distance output, `ref`-generalised, emitted on **all three targets**; verified JS byte-identical [absolute] / JS↔WASM bit-parity [relative] / WebGPU device-compiled. `getAgentOffset` stays for the self→target + Distance shape), `getAgentOffset` (the torus-SHORTEST displacement `(dX, dY)` + `Distance` from self to a target — **use this OR Get Agent Position's relative mode, NOT hand-subtracting two raw positions, for cohesion/separation/"steer toward neighbour" math** so it stays correct across a torus seam; emits the same wrap as the engine, reading `_fieldW`/`_fieldH`/`_fieldBoundaryTorus`), `getAgentAttribute` (a specific agent's attribute — CSE-impure since a neighbour write can mutate it), `getAgentRadius`. With these, **`Form Bond` is now graph-usable** (its target comes from Get Nearby Agents / For Each Bond) — graph-authored bond policy, so `bondContactEvent` is unneeded.
- **Torus-correct graph math (the one graph-side gap the engine doesn't cover).** The engine wraps every relative vector (force delta, bond springs, position integration, the hash stencil, division axis), and `getNearbyAgents` wraps its distance test — but a graph that reads RAW neighbour positions (`getAgentPosition`) and subtracts them itself is NOT wrapped, so near a seam the vector points the long way (the boids artifact, reproduced: a boundary pair converged the long way at |vx|≈0.82 vs a mid pair separating at 0.20). The fix is the `getAgentOffset` primitive above + wrapping `getCurvature`'s bonded-partner offset (it now folds dx/dy to the torus-shortest before `Math.hypot`). **Any new graph node that subtracts two agent positions MUST route through the offset wrap.** `getAgentOffset` (and Get Agent Position's relative mode, which clones its wrap) is CSE-eligible (positions are read-only within a step — writes go to `xNext`), in `MULTI_OUTPUT_TYPES` + `NEVER_INVARIANT`, NOT in `NEVER_PURE_TYPES`. Emitted on all three agent targets (JS / WASM / WebGPU) after Phase F.
- **THE NEIGHBOUR QUERY IS TORUS-CORRECT ON EVERY TARGET — VERIFIED, and pinned (branch `tasks_batch_02-09`).** A user report suspected `getNearbyAgents` of ignoring the torus (a seam artifact). It does not, and neither does anything sharing its machinery — so **do not "fix" the stencil; read this before re-litigating it.** A torus neighbour query has exactly TWO ways to go wrong, both invisible except within one query radius of a seam: the 3×3(×3) hash-bin STENCIL may not WRAP its bin index (`((nb % n) + n) % n`), and the candidate DELTA may not FOLD to the shortest way round. **Both are present at every site**, confirmed by an exhaustive read AND by measurement: JS ([GetNearbyAgentsNode.ts](src/modeler/vpl/nodes/GetNearbyAgentsNode.ts), 2D and 3D arms), WASM (`emitHashStencil` + `emitNearbyFill`'s `foldTorus`), WebGPU (`emitHashStencil` + the `control.fieldTorus` fold), the ALL-PAIRS fallback on every target, and every other consumer of the same stencil — the JS/WASM/WebGPU force pass (soft-sphere, density, springs, charge, **including the B1 bin-sorted mirror body**), `resolvePositionalCollisions`, the auto-bond form/break scan, `getAgentsInView`, `senseHemifield`, the Barnes–Hut charge traversal (node COM + leaf point), `divideAgent`'s tension axis + daughter placement, `nudgeAgents`/`moveAgents`/`pasteAgents`/`getBondState`, and the GPU-resident hash build (whose `computeResidentHashParams` uploads the SAME dims + origin it built with, so stencil and hash cannot disagree).
  - **THE HASH GEOMETRY IS WHAT MAKES THE WRAP LOAD-BEARING, and it is why a naive test is vacuous.** On a torus `buildSpatialHash` tiles the world EXACTLY (`nBinsX = floor(W/edge)`, `binSizeX = W/nBinsX ≥ edge`) from origin 0, and returns **null → all-pairs** below 3 bins on any axis. So a small fixture never builds a hash at all, every target falls back to the (folding) all-pairs path, and a broken stencil passes untouched. Any test here MUST assert `nBins ≥ 3` **and** `binSize > queryRadius` — only then can a seam pair be reached solely through the wrap.
  - **The 2D disc loop of `readCellsUnder`/`affectCellsUnder` takes a RAW delta and that is CORRECT, not a missing fold** (an audit flagged it as asymmetric vs the 3D sphere sibling, which does fold). The loop runs over the agent's OWN local window `floor(c−r) … ceil(c+r)`, so `dx = cc − cx` is already the short way by construction; only the resulting COORDINATE is wrapped, which is exactly what the JS reference, the WASM `emitDiskLoop` and the WGSL all do. Folding there would be a no-op at best. **Do not "make 2D match 3D" here.**
  - **Gate: [scripts/test-torus-neighbours.mjs](scripts/test-torus-neighbours.mjs)** (71 checks). Tier A hand-places seam pairs on the x seam, the y seam and the CORNER (where both wraps apply at once) plus an interior control and an isolated agent; Tier B asserts the hash geometry above; **Tier C is the strong one** — ~400 agents scattered over the torus in 2D and 3D, every agent's count compared against an INDEPENDENT brute-force O(N²) torus recount, with a seam-blind recount asserted to DISAGREE (57 of 400 agents in 2D, 29 in 3D genuinely have a cross-seam neighbour, so a green run is evidence and not a tautology); Tier D is the BOUNDED control, which must give the non-wrapping answer (proving the torus branch is a real branch). Plus a permanent **`[synthetic] Torus seam`** entry in [parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) whose **VALUE invariant** recounts from the store's own positions — parity alone cannot see this class of bug, because both targets share the stencil SHAPE and a shared mistake agrees perfectly. **Negative-controlled by SOURCE MUTATION, both ways:** dropping the WASM stencil's wrap fails 12 seam checks + parity (`attr_nb[0] js=1 wasm=0`); dropping the delta fold on BOTH targets **passes parity** and is caught ONLY by the invariant (`INVARIANT(js) agent 0 … nb 0 !== torus recount 1`).
  - **⚠ WHAT DOES LOOK LIKE A SEAM BUG AND IS NOT ONE — check these first.** (1) **The 2D RENDER does not wrap agents across the seam unless the ∞ infinity canvas is on** (`computeAgentRenderView` / `drawAgentsOverlay` keep `copies = 1` otherwise), so a cluster straddling the seam draws as two half-clusters glued to opposite edges — visually identical to "the seam is not connected", while the physics is fine. The ∞ button is enabled for any 2D torus model (hidden in 3D, where the voxel/sphere scene is drawn once). (2) **A graph that hand-subtracts two ABSOLUTE `getAgentPosition` reads** gets the long way round near the seam — the documented footgun in the bullet above; use Get Agent Offset or Get Agent Position's RELATIVE mode. (3) **A query radius above the model's Neighbour Query Radius** under-counts on every target (the stencil reaches one bin) — the documented sizing rule, not a torus issue; all shipped torus agent models satisfy it (Particle Life: bins 16×16 of 25 vs a slider capped at 24; Particle Life 3D falls to all-pairs; Boids 35×21 of 14.28 vs nqr 14).
- **Division-event param scope.** `buildDivisionParams`/`buildDivisionArgs` (the single-agent division-event signature) were expanded so the agent-read nodes (`getAgentOffset`/`getCurvature`/`getVelocity`/`fieldGradient`) are division-safe: they now also carry `_alive`, `highWater`, `_agentVX`/`_agentVY`, `maxBonds`/`_bondPartner`, and the field block (`_fieldW`/`_fieldH`/`_fieldTotal`/`_fieldBoundaryTorus` + `_field_<id>`) — the SAME symbols in the SAME order in both (the ABI-mirror discipline). The `_hash*`/request buffers stay out (division is single-agent, non-loop).
- **Flow** (`output`, NOT async-only): `setTargetRadius`, **`applyForce`** (add a force vector — the GRAPH authors the physics: flocking, chemotaxis up a Field Gradient, propulsion; the engine integrates the sum), **`setAttribute` with its optional `Agent` id WIRED** (write ANOTHER agent's attribute by id — signal a neighbour; immediate single-buffer/async-style write, id range-guarded), `formBond`/`breakBond`, `forEachBond` (iterate the ragged bond list — a flow construct in `compileFlowChain` exposing partner/restLength/currentLength/index; `findElementDependents` parameterised), `divideAgent` (axisSource "tension axis"), `killAgent`, `affectCellsUnder`/`secreteToField` (the field-bridge writes).
- `Get Cell Position` is LATTICE-only; agents use `Get Self Position`.

### Agent Stop Event (all 3 agent targets — branch `absorb_old_automatosgt`)
A **Stop Event** node in the agent BEHAVIOUR graph now pauses the simulation on every agent target (JS + WASM + WebGPU); it was a JS-only carve-out. The `_stopIdx` (1-based, offset by the cell stop count via `stopIdxBase`) is baked by the JS `compileAgentGraph` (runs first in SimulatorView) on the original nodes — `expandMacros` passes top-level nodes by reference, so the WASM/WebGPU agent compilers read the same baked config (exactly like the cell grid).
- **JS**: unchanged — the behaviour writes the shared `_stopFlag[0]` via the ABI's `_stopFlag` param.
- **WASM**: `computeAgentMemoryLayout` ([agentEngine.ts](src/simulator/engine/agentEngine.ts)) **appends** a 4-byte `stopFlagOffset` cell (always reserved → existing offsets byte-stable, verified: parity + gate + ABI audit unchanged). `stopEvent` ∈ `AGENT_WASM_SUPPORTED_TYPES` with an emitter mirroring the cell WASM (`if i32.load(stopFlagOffset)==0 { i32.store(stopFlagOffset, stopIdx) }`).
- **WebGPU**: a dedicated `stopFlag` atomic<u32> storage buffer (**binding 13**, gated on the `usesStop` flag like `usesSpawn`/binding 12), `atomicCompareExchangeWeak(&stopFlag, 0u, stopIdxU)` in the shader; `resetAgentStopFlag` seeds it to 0 before each dispatch, `readbackAgentStep` returns it, `runAgentStepWebGPU` merges it into `stopFlag[0]`.
- **The ordering fix (also fixes a pre-existing JS-agent bug)**: the agent step runs BEFORE the cell step in every batch loop, and `runStep`/`runStepWebGPU` reset the shared `stopFlag` at their top (finalizeStepWebGPU even OVERWRITES it from the GPU) — which clobbered an agent stop in a grid+agents model. New `drainAgentStop()` ([sim.worker.ts](src/simulator/engine/sim.worker.ts)) reads the agent stop source (JS/WebGPU → `stopFlag[0]`; WASM → the memory cell) + clears both; each batch loop **captures** it before the cell step and **surfaces** it after `generation++` (so the paused generation matches the cell-stop semantics). Gated on `agentStore && simulateAgents` → cell-only models are byte-identical.
- **Verified** (real worker, all 3 targets): an agents-only `behaviourStep → stopEvent` fires "AGENT STOP FIRED" at gen 1 on JS / WASM (gate accepts, module emits it) / WebGPU (real-GPU shader compiles + the atomic + readback merge, 0 errors); a **cell-only** stopEvent still fires (unregressed); a **grid+agents** agent stop fires (the clobber fix). tsc + build + parity (11 samples) + WASM gate + ABI audit all green.

### Cross-Agent Write Semantics (branch `sim_agent_fixes`) — sync-overwrite gate + Apply Force To Agent
The agent form of the CA grid's **Fundamental #4 (Writability)**, plus the commutative force sibling it enables. **The throughline: OVERWRITE writes race across agents; ACCUMULATE writes don't** — so the two get opposite rules. Plan + Impact Map + mockup: [docs/PLAN_CROSS_AGENT_WRITES.md](docs/PLAN_CROSS_AGENT_WRITES.md) / [IMPACT_MAP_CROSS_AGENT_WRITES.md](docs/IMPACT_MAP_CROSS_AGENT_WRITES.md) / `.html`. All additive/gated — lattice + every non-touched agent model byte-identical (JS↔WASM parity re-verified on all samples).
- **Part A — cross-agent OVERWRITE writes are async-only.** A WIRED `setAttribute` (with a scalar id OR an id ARRAY) / `setAgentPosition` / `setAgentRadius` / `setVelocity` / `setTargetRadius` writes ANOTHER agent's slot; in **sync** agent mode (double-buffered attrs) that collides with the target's own self-update (lost update, order-dependent, a genuine data race on parallel targets). A single **compile-time gate** in `compileAgentGraph` ([compile.ts](src/modeler/vpl/compiler/compile.ts), right after `buildAdjacency`) rejects them when `centerBased.agentUpdateMode === 'sync'` AND the node is reachable from the **behaviour** root (a BFS over `flowOutputToTargets` — init/division roots are sequential one-time / structural-phase, never the parallel self-update loop, so NOT gated) AND the target isn't a one-hop **`createAgent` handle** (spawn configuration: the staged newborn isn't concurrently written — the exemption that keeps unified spawning working in sync mode). The JS compile always runs first in SimulatorView, so its error short-circuits ALL targets (no per-target copy needed). **In ASYNC mode the cross-agent overwrites are legal but SEQUENTIAL-order-dependent, which the parallel GPU cannot honour** — so `isAgentGraphWebGPUSupported` ([agentWebgpu/compile.ts](src/modeler/vpl/compiler/agentWebgpu/compile.ts)) rejects any behaviour-reachable member of the same 5-type set whose id input is WIRED to a non-`createAgent` source (unwired = `-1` = guarded no-op; a spawn handle is thread-owned — both race-free): such a model clamps to JS/WASM, where the sequential agent loop gives a well-defined write order. This closed a real hole — before this gate an async cross-agent-overwrite model silently EMITTED on WebGPU with racy last-writer-wins visibility. (NB the earlier "WebGPU is sync-only" phrasing here was WRONG — the WebGPU agent target runs `agentUpdateMode:'async'` models fine [Tissue is async]. The follow-on claim that on the GPU "the mode only governs CPU-side buffering + residency eligibility, since a parallel dispatch always gives snapshot-reads + thread-own-writes regardless" was ALSO wrong, and is what PX fixed: thread-own-writes is only snapshot semantics for an agent's OWN slot — reading a NEIGHBOUR's attribute out of the same run someone else is writing is a race. Sync now allocates a distinct write run + commits it per generation; see the PX section.) `setVelocity` is self-only (no id input) → untouched.
- **Part B — `applyForceToAgent`** ([ApplyForceToAgentNode.ts](src/modeler/vpl/nodes/ApplyForceToAgentNode.ts)): add a force vector to another agent by id (`force[target] += f`), the cross-agent counterpart to Apply Force. **Commutative** (`+=` onto the per-step-zeroed force buffer the integrator consumes AFTER the whole behaviour pass) → **race-free in BOTH sync and async** (order doesn't matter for a sum; no collision with the target's own Apply Force). Newton's 3rd law, custom pairwise / Coulomb laws, action-at-a-distance. Ports mirror Apply Force (`fx/fy/fz`, `fz` 3D-only) + an `agentId`; range+alive guarded (live-agent guard in behaviour/division, `_agentMaxAgents` range-only in init); `AGENT_NODE_REQUIREMENT` → `motion: 'force'`. **(Note the corrected Apply Force semantics: it ACCUMULATES `+=` onto a buffer zeroed each step — `s.forceX.fill(0,0,hw)` — then the fused pass seeds from it and the engine adds its own soft-sphere/springs on top; a single call ≈ "set from 0", N calls sum. Not "set the force".)**
- **All three targets** (the ALL-TARGET rule — no JS-only clamp): **JS/WASM** — a plain guarded `+=` (the behaviour loop is SEQUENTIAL, no atomics; WASM `forceAddAt` = the arbitrary-target sibling of `forceAdd`, in `AGENT_WASM_SUPPORTED_TYPES`). **WebGPU** — the parallel scatter CONTENDS (many threads add to the same target → lost-update race on the read-modify-write), so it goes through an **f32-bitcast atomic-CAS** (`forceScatterAdd`, the EXACT `fieldDepositCell` pattern) into a dedicated `forceScatter : array<atomic<u32>>` buffer (**binding 14**, gated on the new `usesForceScatter` flag like `usesSpawn`/`usesStop`), X/Y[/Z] regions strided by `maxAgents`; the runtime `clearBuffer`s it each step ([agentWebgpuRuntime.ts](src/simulator/engine/agentWebgpuRuntime.ts)), and the **force pass** reads its own slot (no contention → plain `bitcast<f32>(forceScatter[i])`, **binding 4**, gated) and folds it into the self-force seed. Self Apply Force stays a plain non-atomic write (each thread owns its slot). `usesForceScatter` threads compile-result → SimulatorView (`emitAgentForcePassWGSL(layout, usesForceScatter)`) → init/recompile msg → `createAgentWebGPURuntime` usage — same plumbing as `usesSpawn`. A no-scatter (Boids) shader is byte-identical (no binding 14/4, no helper).
- **Array broadcast — `applyForceToAgents`** ([ApplyForceToAgentsNode.ts](src/modeler/vpl/nodes/ApplyForceToAgentsNode.ts)): add the SAME force to EVERY agent in an id array (feed Get Nearby / Bonded / Filter Agents). **Pure editor sugar with ZERO new per-target emit** — a shared pre-compile transform **`expandForceToAgents`** ([forceToAgentsExpand.ts](src/modeler/vpl/compiler/forceToAgentsExpand.ts)) lowers it to **`For Each In Array → applyForceToAgent`** (the sanctioned "lower to primitives" pattern — `expandComposites`/`expandMultiAttrs`/`lowerVectorAttrs`), so it reuses the single node's JS/WASM/WebGPU emitters ENTIRELY. Wired into all three agent front-ends right after `collapseReroutes` (JS `compileAgentGraph` + both `flattenAgentGraph`s), so the agent-target GATE inspects the flattened graph (`forEachInArray` + `applyForceToAgent`, both supported) — `applyForceToAgents` needs NO supported-types entry. Bit-parity inherited from the two verified primitives; semantically identical to the hand-built For-Each pattern. Hot-path no-op when unused.
- **Verified**: tsc + `npm run build` clean; Part A gate (real compiler — sync→error, async→compiles, `createAgent`-handle→exempt); Part B **JS↔WASM bit-parity** ([scripts/parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) `buildApplyForceToAgentModel` pairwise scatter + `buildApplyForceToAgentsModel` array broadcast, 30 steps, 0 mismatches) + WGSL generation + the lowering ([scripts/test-cross-agent-writes.mjs](scripts/test-cross-agent-writes.mjs), Parts A/B/C, 2D+3D); **real-GPU** (in-browser) — both behaviour + force shaders `createShaderModule` with **0 errors** (2D+3D, single node AND the array node's scatter-CAS-inside-forEach), the runtime BUILDS (bind groups match pipeline layouts) and a real `dispatchAgentStep` runs with **0 validation errors**. Catalogue → **143 selectable / 47 agent**.

### Neighbour Density gains an optional Radius (all 3 agent targets — branch `tasks_batch_2026_08`)

User TODO: *"make 'density' receive an attribute for the radius, and if empty it uses the
default sensing radius of the properties."* `neighbourDensity` now has an optional **Radius**
input. **UNWIRED / 0 ⇒ nothing changes** and every existing model is byte-identical
(`check-compile-identity`: 31 models, all surfaces unchanged — no shipped model wires it).

- **THE TWO MODES ARE GENUINELY DIFFERENT MEASUREMENTS, and both are documented on the node,
  in Help and in NODES_REFERENCE.** Unwired reads the ENGINE reduction `_agentDensity[idx]`,
  whose exact predicate (read off the JS force loop and mirrored by the WASM/WGSL force
  passes) is *alive `j ≠ i`, torus-shortest distance `d` with `0 < d < interactionRange ×
  (r_i + r_j)`* — a **RELATIVE** cutoff that scales with the pair's summed radii, counted for
  free inside the fused neighbour pass and therefore **ONE GENERATION STALE** (the force pass
  runs AFTER the behaviour). Active reads a **FRESH count, this generation, of the other alive
  agents within an ABSOLUTE radius** (`d ≤ radius`, self excluded, coincident agents INCLUDED
  — the engine reduction skips `d = 0`).
  ⚠ **The unwired mode is NOT "the Neighbour Query Radius"** the TODO assumed — that property
  only sizes the spatial-hash bin. Keeping unwired on the engine reduction is what makes the
  change byte-identical; re-pointing it would have silently altered every existing model.
- **ONE pre-compile LOWERING, zero per-target emit** ([densityExpand.ts](src/modeler/vpl/compiler/densityExpand.ts)):
  an active Radius rewrites the node into `Get Nearby Agents(radius) → Array Length` BEFORE any
  target compiles (the `censusExpand` / `expandForceToAgents` pattern), wired into all three
  agent front-ends immediately after `expandNeighbourCensus`. The agent GATES inspect the
  FLATTENED graph, so they see only node types they already support — JS / WASM / WebGPU by
  construction, bit-parity inherited from the primitives, and **no gate, supported-type set or
  emitter was touched**. Deterministic synthetic ids (`__dnG` / `__dnLen`), consumed-output-only,
  hot-path no-op.
- **THE ACTIVATION PREDICATE lives in ONE function** (`densityRadiusActive`): the port is WIRED,
  **or** its inline value parses to a finite number **> 0**. Blank / absent / 0 / non-numeric all
  mean "engine reduction", which is why the port's `defaultValue` is `'0'` and a freshly dropped
  node behaves exactly as it always did.
- **THE THREE DENSITY GATES NOW SHARE ONE PREDICATE**, `agentGraphReadsEngineDensity(model)`
  (macro-aware, each macroDef scanned against ITS OWN edges so a Radius fed from a `macroInput`
  reads as wired): `divideAgent` always counts (its degenerate-axis fallback reads the reduction
  in the engine), a `neighbourDensity` counts **only while its Radius is inactive**. It replaced
  the three independent node-type scans in `resolveAgentFieldGates` (the `density` SoA field),
  `SimulatorView.agentUsesDensity` (→ the worker's `doScan`) and `generationPipeline`'s pipeline
  row. **Without this narrowing the feature's own headline case would be a regression**: a model
  whose density nodes all carry a Radius would keep running the full O(N·k) neighbour scan every
  generation for a number nobody reads — exactly the dead scan P1 removed.
- **The array-producer budgets need no edit**: the lowering costs ONE slot (WASM
  `AGENT_NEARBY_SCRATCH_SLOTS` = 4 / WebGPU `AGENT_WEBGPU_NEARBY_SLOTS` = 6) and both gates count
  the flattened graph, so an over-budget graph clamps to JS exactly as a hand-wired Get Nearby
  Agents would. `targetDiagnosis.countAgentArrayProducers` is left alone — it walks by TYPE with
  no edges and is already self-declared *"best-effort … never to decide it"*, so a radius-wired
  density can understate that explanatory number by one; the real gates are exact.
- **`AGENT_NODE_REQUIREMENT` is unchanged** (`neighbourDensity: 'sensingOrCollision'`, whose
  closure widens to `sensing`): the table is TYPE-keyed and cannot see a per-node radius (the
  `neighbourCensus` precedent), and nothing gates the lowering at runtime — **the spatial hash is
  built unconditionally every generation**, before the behaviour, so the query always works.
- **THE CAVEAT INHERITED FROM `getNearbyAgents`, stated on the node + in Help**: the hash bin edge
  is `max(interactionRange·2·maxR, neighbourQueryRadius, chargeBinEdge)`, so a radius ABOVE the
  model's **Neighbour Query Radius** silently UNDER-counts (the 3×3(×3) stencil does not reach).
- **Verified.** `check-compile-identity` **31 models, all surfaces unchanged**; a permanent
  `[synthetic] Neighbour Density Radius (engine reduction / inline / wired, lowered)` entry in
  [parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) carrying all three shapes in ONE graph,
  whose **VALUE invariant** recomputes each from the store's own positions / density array with a
  torus fold (and asserts the fixture DISCRIMINATES — the three answers differ, and two rows of
  agents are pushed onto opposite sides of the seam so the fold is load-bearing).
  **Negative-controlled by SOURCE MUTATION, both ways**: dropping the inline-radius carry-over
  gives `inline-radius density 14 !== recount(3) 8`; ignoring a WIRED edge gives
  `wired-radius density 100 !== recount(2) 5` — `100` being the seeded engine reduction, i.e. the
  invariant tells the two MODES apart, not just the two targets.
  **Real worker, all three agent targets** (60 agents, 3 generations, values read back through
  `readAgents` and recounted independently in-page): **0 of 180 values wrong on WebGPU, WASM and
  JS alike**, with `agentEngineActive` reading `webgpu` / `wasm` / `js` and **0 fallback events**,
  and all three modes differing on all 60 agents (engine 3 · inline r=3 → 8 · wired r=2.6 → 7 for
  agent 0). The WGSL additionally compiles on a **real device** with 0 shader and 0 validation
  errors.

### Agent action TARGETING — optional id, default self (branch `polishing`)

User report: *"We have no way to 'kill' an agent from its id now? not even the 'self'?? … only
the 'kill agent' that destroys the current evaluated agent? that is very limiting … it should
all be consistent in providing either an id or assuming self, unless there is a strong
technical reason not to."* Plus the same for Set Velocity, *"following the example of the node
'Get Velocity' that the user can provide an agent or leave empty for the 'self'."*

**THE CONVENTION, now uniform: an agent action either takes an OPTIONAL `Agent` id whose
UNWIRED state means SELF, or has a by-ID sibling node.** The id port is always
`{ id: 'agentId', label: 'Agent', dataType: 'integer' }` — literally Get Velocity's port, so
the read and write halves of every pair look the same.

**THE BYTE-IDENTITY DISCIPLINE (inherited from Form Bond's `agentA`, and non-negotiable):
wiredness is read from the EDGE MAP and resolved BEFORE anything is minted** — `em.allocLocal`
changes the WASM module bytes even for an *unused* local, and `fresh()` shifts every later WGSL
name. Unwired therefore emits the historical statement byte-for-byte on all three targets
(`check-compile-identity`: 29 models, every surface unchanged).

#### The three nodes that gained the optional id
| node | unwired | wired | gated? |
|---|---|---|---|
| **Kill Agent** | `_killRequest[idx] = 1` | `_killRequest[target] = 1` — PREDATION ("consume" a neighbour) | **NO** — see below |
| **Set Velocity** | `_agentVX/VY[idx] = …` | writes that agent's velocity (knock-back) | **YES** — cross-agent OVERWRITE |
| **Set Target Radius** | `_agentTargetRadius[idx] = …` | makes ANOTHER agent grow/shrink | **YES** — cross-agent OVERWRITE |

**WHY A WIRED KILL NEEDS NO GATE — the commutativity argument, and it is the load-bearing
reasoning here.** A kill is a **flag set to a CONSTANT** (`killRequest[t] = 1`) consumed once by
the CPU structural phase at the end of the step. Setting the same value is **IDEMPOTENT and
ORDER-INDEPENDENT**: N agents all electing to eat the same target produce the identical result
in any order, and it cannot collide with that target's own self-update (nothing ever writes the
flag back to 0). That is exactly the argument that exempts **Apply Force To Agent**'s
commutative `+=`. So `killAgent` is deliberately **NOT** in `CROSS_AGENT_OVERWRITE`
(compile.ts' synchronous-mode gate) and **NOT** in the WebGPU agent gate's wired-non-spawn
reject set — verified, not assumed: a kill-only model's `isAgentGraphWebGPUSupported` returns
**true** and it runs natively on the GPU. On WebGPU the store is a plain **non-atomic** write of
`1.0` into another slot's `killRequest` run — a benign race, because every racing writer writes
the identical value — and `readbackAgentStep` already rounds it (`>= 0.5 ? 1 : 0`).
**Set Velocity / Set Target Radius are the opposite**: last-writer-wins overwrites, so they join
the same machinery as a by-id Set Attribute / Set Agent Position / Radius (the set is **six**
types in both gates). For an order-independent way to influence another agent's motion, Apply Force To
Agent works in both modes on every target.

**Guards** mirror the by-id setters exactly: range-only (`< _agentMaxAgents`, WASM's shared
`emitGuardedAgentWrite`, WGSL's `< i32(control.maxAgents)`) in the init/behaviour roots — the
unified-spawning relaxation that lets a staged Create Agent handle be configured — and
range+alive elsewhere. For the kill, range-only is *provably equivalent* to range+alive because
the structural phase separately gates on `alive[i]`, and a recycled slot is cleared by
`initAgentSlot`.

**⚠ THE INIT-ABI ASYMMETRY THIS EXPOSED (a real trap):** `deriveAgentAbi`'s **init** kind carries
`_agentZ` but **NOT `_agentVZ`**, and `_killRequest` is **loop-only**. So a wired Set Velocity in
the Agent Init Event (a legitimate "seed a newborn's velocity on its handle" use) would have
emitted an undefined `_agentVZ` in 3D — it now **drops the z half in the init root** (the C9
"no param ⇒ no write" safety-catch shape) rather than widening the ABI. Kill Agent stays
unconditionally init-invalid either way. `nodeValidation`'s `AGENT_SELF_ONLY_WHEN_UNWIRED`
makes that badge WIRING-aware for the two conditional nodes.

#### THE AUDIT — every agent action node's targeting (the sweep behind the convention)
| node | targeting | why |
|---|---|---|
| Apply Force / **Apply Force To Agent** / Apply Force To Agents | self / **by id** / array | complete trio already. The by-id node's unwired id has NO self meaning (Apply Force IS that) ⇒ it stays a badged silent no-op |
| **Get Attribute (by ID)** / **Get Position (by ID)** (absolute) / **Get Radius (by ID)** | **optional id ⇒ self** | ✅ shipped 2026-09-02 — see "The by-id READERS default to self" below. They used to emit the −1 sentinel ⇒ a silent read of 0, which the badge merely reported; reading "the current agent" is a valid use and is what the rest of the family already means |
| **Get Velocity** | optional id ⇒ self | already the convention (and the precedent every other reader now follows) |
| **Get Agent Offset** | by id (required) | an offset to yourself is identically zero — there is no self meaning to default to, so it stays badged |
| **Set Attribute** | **optional id ⇒ self / one agent / an id ARRAY** | ✅ FULLY CONSOLIDATED (2026-08-11/12) — `setAgentAttribute` ("Set Attribute (by ID)") AND `setAgentsAttribute` ("Set Agents Attribute") were both RETIRED into Set Attribute's one optional `Agent` port, which is scalar-or-array. See "Retiring the Set Agent Attribute node" + "Retiring the Set Agents Attribute node" |
| **Set Agent Position** / **Set Agent Radius** | by id (required) | by-ID half of a documented pair; `Get Self Handle` is one wire away, and their unwired no-op is the spawn-handle idiom. **Left required deliberately** — defaulting them to self would silently retarget existing graphs |
| **Kill Agent** | **optional id ⇒ self** | ✅ this change — had NO by-id sibling |
| **Set Velocity** | **optional id ⇒ self** | ✅ this change — had NO by-id sibling |
| **Set Target Radius** | **optional id ⇒ self** | ✅ this change — Set Agent Radius sets the CURRENT radius, so the GROWTH TARGET was unreachable for any other agent |
| Set Agent Sprite | optional id ⇒ self | already the convention |
| Form Bond | optional `agentA` ⇒ self + `targetAgent` | already (lowers to the Form Between encoding when wired) |
| Form Bond (paired) / Transfer Bond | two / three explicit ids | inherently multi-party |
| **Break Bond** | **optional id ⇒ self** | ✅ shipped — wired, it cuts the bond between two OTHER agents (see "Break Bond names BOTH ends" below) |
| Set Bond Attribute / Rewire Bond | self-anchored pair | Rewire is anchored at the requester by definition (it moves *my* edge); the third-party form of that is **Transfer Bond**. Set Bond Attribute is the one remaining self-anchored pair |
| Divide Agent | self only | dividing another agent by id would need the Division Event (which runs per-DAUGHTER of the divider) to answer "whose event is this?", plus a partition spec chosen by an agent that is not the mother. A semantic redesign, not a port |
| Add Agent To World / Create Agent | by handle | a handle IS the target; "self" is meaningless |
| affectCellsUnder / secreteToField / sampleField / fieldGradient / readCellsUnder | self position | the node's identity is "the cells **under this agent**"; a by-id variant is a plausible future node, not a port on these |
| moveSelfToNeighbor etc. | — | lattice nodes, out of scope |

#### The by-id READERS default to self (branch `tasks_batch_02-09`, 2026-09-02)

User report: *"'Get Attribute by ID' is giving warnings if no agent id is connected, but that is
a valid use case, when the user is referring to the 'current' agent."* Correct — and the project's
own convention already said so for every optional-id WRITER. **`getAgentAttribute` /
`getAgentPosition` (absolute mode) / `getAgentRadius` now read the CURRENT agent when their
`Agent` input is unwired**, on all three agent targets, and the `BY_ID_UNWIRED` badge came off
them. `check-compile-identity`: **31 models, all surfaces unchanged.**

- **THE WIRED ARM IS BYTE-IDENTICAL, and that is structural, not careful.** Wiredness is resolved
  from the EDGE MAP **before anything is minted** — `em.allocLocal` moves the WASM module bytes and
  `fresh()` shifts every later WGSL name even when the value is unused, so the WASM/WebGPU cases
  test `ctx.adj.inputToSource.get(\`${node.id}:agentId\`)` FIRST and only then call
  `emitAgentIdLocal` / `emitAgentIdGuarded` (the `getVelocity` precedent, which those three now
  copy line for line). On JS the port carries **no inline widget**, so `inputs['agentId']` IS the
  edge-map test.
- **The self read is UNGUARDED** (`r_<attr>[idx]` / `_agentX[idx]` / `_agentRadius[idx]`) — `idx` is
  live by construction, exactly as `getCellAttribute` and `getVelocity` have always emitted. Only
  a WIRED id can be −1 or out of range, so only it keeps the guard.
- **SELFLESS ROOTS (`init` / `spawner`) have no `idx`, so an unwired reader degrades to the typed
  default** (`const _v<id> = 0;`) rather than emitting a reference that throws at run time — the
  `setVelocity` / `setAgentSprite` safety-catch shape, via the shared `agentRootHasSelf`. The three
  stay UNCONDITIONALLY in `AGENT_SELF_ONLY_TYPES` (wired they emit `< highWater`, unwired they mean
  `idx`; neither is in the init ABI), so the badge still preempts the placement — the degrade just
  makes a stale one inert instead of fatal. **WASM and WebGPU need no such arm**: they compile the
  behaviour root only (`AGENT_WASM_CPU_ROOT_TYPES`), where `idx` always exists.
- **RELATIVE mode keeps the sentinel, deliberately.** With `refId` already defaulting to self, an
  unwired `Agent` there would be self−self = the SAME zero vector the failed guard produces — so
  "unwired = self" holds observationally either way and the emitted code is left untouched.
- **What stays REQUIRED, and why it is not an inconsistency**: `getAgentOffset` (an offset to
  yourself is identically zero) and the by-id WRITERS `setAgentPosition` / `setAgentRadius` /
  `applyForceToAgent`. Changing a silent READ of 0 into a self read is safe; changing a silent
  NO-OP WRITE into a self write would **silently retarget existing graphs**, and those three exist
  to configure a Create Agent handle. `applyForceToAgent` was **added** to `BY_ID_UNWIRED` here —
  it is in exactly that silent-no-op class and had been missed (0 false positives: no shipped model
  uses the node at all).
- **Port labels** read `Agent (self)` on the three readers (the `formBond.agentA` precedent).
  Labels are display-only — nothing in the compilers, the drag/drop matcher or any harness keys on
  them.
- **⚠ A PRE-EXISTING SIBLING GAP, found by this work and deliberately NOT fixed**: an UNWIRED
  `setAttribute` in a selfless root still emits `w_<attr>[idx]` (line 85 of
  [SetAttributeNode.ts](src/modeler/vpl/nodes/SetAttributeNode.ts)) and throws at run time, where
  `setVelocity` degrades to `''`. It is already badged (`AGENT_SELF_ONLY_WHEN_UNWIRED`), and
  `setAttribute` is the most-used node in the catalogue — its cell path must stay byte-identical —
  so the fix belongs in its own change, not this one.
- **Verified**: `check-compile-identity` 31/31 unchanged · a new
  [scripts/test-by-id-self-default.mjs](scripts/test-by-id-self-default.mjs) (**86 checks** — the
  JS emit shapes, the WASM arms emitting DIFFERENT bytes and both modules VALIDATING, the WGSL
  shapes, the selfless-root degrade + its badge, and the whole badge set) · a permanent
  `[synthetic] By-id READERS unwired = self` entry in
  [parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) whose **VALUE invariant** recomputes all
  six reads from the store's own energy / radius / x arrays, deliberately targeting `self + 1` so
  the last agent exercises the guard arm. **Negative-controlled by SOURCE MUTATION — 5 mutations,
  5 caught**: a WASM-only unwired→0 fails PARITY (`attr_selfE[0] js=1 wasm=0`); making BOTH targets
  read self for the WIRED port passes parity and is caught ONLY by the invariant (`agent 0: byE 1
  !== energy[1] 2`); reverting the JS unwired arm fails both; reverting the WebGPU unwired arm
  fails the WGSL checks (parity cannot see WebGPU); and dropping the selfless-root catch fails the
  init assertions.

#### `Break Bond` names BOTH ends too — the third-party cut (the both-negative lane pair)

**SHIPPED** (this closes the follow-up recorded here at `5ee1407`). Break Bond gained the SAME
optional **`agentA`** port Form Bond has, with the same id, the same "Agent A (self)" label and
the same default: **unwired ⇒ THIS agent** (the historical self-anchored break, byte-identical
on all three agent targets); **wired ⇒ cut the bond between the two NAMED agents**, neither of
which need be the requester. No "Between" spelling anywhere — it is just Break Bond.

**This was the last edge mutation the verb set could not express.** Rewire and Transfer are both
anchored AT THE REQUESTER by construction (they move *my* edge), so before this nothing could
sever an edge a rule is not part of.

- **THE ENCODING — BOTH lanes negative**, the one sign combination Form Between (−,+) and
  Transfer (+,−) left free: `bondBreakReq = −(a+2)`, `bondFormReq = −(b+2)`. **Zero new fields,
  zero moved offsets** (the P4b argument), so `check-compile-identity` stays 29/29. The sign
  table is now COMPLETE — a seventh op kind would need a real field, not another sign. An
  unresolvable side writes (−NONE, −NONE) = (−1, −1): still non-zero on both lanes (it cannot
  truncate the queue) and still both-negative (it decodes as this verb, as an explicit no-op).
- **⚠️ DECODE ORDER IS LOAD-BEARING and this arm goes FIRST**, ahead of BOTH single-sign tests.
  `bl < 0` alone is Form Between's marker, so a both-negative entry falling into that branch
  decodes its second id from a NEGATIVE lane, gets −1, fails that arm's `b >= 0` gate and is
  **DROPPED — the bond silently survives, with no error anywhere**. Milder than Transfer's
  failure (which destroys an edge) but equally invisible. Proven by SOURCE MUTATION: disabling
  the branch fails **24** Tier P checks with exactly that symptom (`1:2 -> 1:2`).
- **`breakBondBetween(store, a, b)`** ([agentEngine.ts](src/simulator/engine/agentEngine.ts)) is
  the whole-op gate — `a`/`b` live, in range, distinct, and the edge must EXIST — then plain
  `breakBond`, which removes both rows' slots (**I2**) and compacts each (**I3**). A cut that
  cannot apply touches NOTHING (**I5**): not a slot, not a degree.
- **All three agent targets**, through the shared emitters, with wiredness read off the EDGE MAP
  and resolved **before any local or WGSL name is minted** (`em.allocLocal` moves the module
  bytes and `fresh()` shifts every later name even when unused — the Form Bond discipline). The
  port carries **no inline widget**, which is what makes the JS `inputs[...]` test the edge-map
  test. **No atomics on WebGPU**: the two ids are PAYLOAD on the requester's own rows.
- **Nothing else needed changing, and each was checked rather than assumed**: `geometryTaint`
  already taints every `breakBond` value input (it is in `STRUCTURAL_VERBS` with no
  `GEOMETRY_ONLY_INPUT_PORTS` entry), so a proximity-derived `agentA` taints exactly like Form
  Bond's — **verified by running the analyzer**, witness `Get Nearby Agents · agents → For Each
  In Array → Break Bond · agentA`, while a self-handle-only graph stays presentational.
  `breakBond` was already in `BOND_REQUEST_NODE_TYPES`, `targetDiagnosis`' residency STRUCTURAL
  set and `AGENT_NODE_REQUIREMENT` → `bonds`; it stays UNCONDITIONALLY init-invalid in
  `nodeValidation` because the request queue is loop-only in the ABI (the `killAgent` reasoning),
  so wiring makes no difference there.
- **Verified.** Byte-identity **29/29, every surface**. `verify-graph-rewrite` **543 → 612**
  (Tier P: the six-op sign matrix from one starting graph, the decode-order trap, an 8-case I5
  rejection matrix each asserting the graph is EXACTLY unchanged + a probe queued behind it still
  applying, I2/I3 double compaction, multi-op batches, and the emit shape + both gates on all
  three targets). `parity-agent-wasm` gained the permanent `[synthetic] Break Bond pair port (the
  BREAK BETWEEN sign matrix)`, whose VALUE invariant lays entries 1/2/3 side by side carrying the
  SAME two ids so the three encodings must differ ONLY in signs — **negative-controlled both
  ways**: WASM-only dropping the negation fails PARITY (`bondFormReq[1] js=-3 wasm=3`), while
  BOTH targets dropping it identically passes parity and is caught only by the INVARIANT
  (`entry 1: formLane 3 !== -3`). **Real worker, all three agent targets** (JS / WASM / real GPU,
  `agentEngineActive: 'webgpu'` with 0 fallback events): from a ring `0-1…6-7`, agent 0 cuts the
  2↔3 edge it is not part of — **identical result on all three** (exactly that edge gone, both
  endpoints' degrees −1, the requester's own bond untouched), 0 console errors; and the shipped
  `Growing Graphs` still holds `N=562, E=843=3N/2, min=max degree 3, 0 dangling, 0 asymmetric`.

- **Verified.** Byte-identity **29/29, every surface**. Harnesses: `parity-agent-wasm`
  (JS↔WASM bit-parity, all samples + a new permanent `[synthetic] By-id targeting` entry),
  `verify-graph-rewrite` **533**, `test-agent-abi` **607**, `test-c9-gates` **413**,
  `audit-agent-layout`, `test-cross-agent-writes`, `parity-agent-force` **43**,
  `check-agent-wasm-gate`, `gen-capability-docs --check`. The new synthetic splits the
  population into hunters + prey + BYSTANDERS and recomputes every expected number from the
  agent's HANDLE, so a by-id write that spills onto an untargeted slot is caught;
  **negative-controlled both ways** — WASM-only dropping the kill guard fails PARITY
  (`killRequest[0] js=0 wasm=1`), while making BOTH targets write self (which parity cannot
  see) fails the VALUE INVARIANT.
- **Real UI** (a "Consume" model: each agent knocks back every neighbour within r=3 and eats the
  one within 1.6, with a `self < other` tie-break): from ONE pinned seed **JS and WASM produce
  the IDENTICAL series 400 → 248 → 245 → 244 → 244** with 240 agents carrying the by-id
  knock-back velocity (read via `readAgents` — the render snapshot's `vx` is a length-0 array
  unless velocity is REQUESTED, the documented trap); the same model on the WebGPU agent target
  correctly **clamps to JS** (`isAgentGraphWebGPUSupported` false, chip `⚙ agents JS⚠`) with
  identical results; a **kill-only** variant runs **natively on the real GPU** (chip
  `⚙ agents WebGPU`, no fallback, 400 → 248) — the commutativity claim, demonstrated; and the
  same model in SYNCHRONOUS agent mode produces the named compile-gate error. 0 console errors.

#### Retiring the `Set Agent Attribute` node (branch `polishing`, 2026-08-11)

The Set half of the audit table's "complete trio" was two spellings of one write, so
`setAgentAttribute` ("Set Attribute (by ID)") was **removed** and `Set Attribute` is the single
attribute-writing verb — the Form Bond Between retirement applied to the other pair. User call:
*"Why having a 'Set Self Attribute' and a 'Set Attribute (by ID)'. It should just be 'Set
Attribute' and follow the same standard of Set Velocity."*

- **THE NEW MECHANISM: `hiddenPorts` gained a third argument, the ACTIVE GRAPH KIND.**
  `setAttribute` is UNIVERSAL, so its `Agent` port must exist on the Agents graph and NOT on the
  Cells graph (a lattice cell has no agent id) — the first port whose visibility depends on the
  graph rather than on config. `NodeTypeDef.hiddenPorts?: (config, model?, graph?) => string[]`
  ([types.ts](src/modeler/vpl/types.ts)), and BOTH consumers — CaNode's render path and
  `effectivePorts.getEffectivePorts` — pass `getActiveGraphKind()`. **An explicit argument, not a
  `getActiveGraphKind()` call inside the node def**: the hook stays a pure function of its args,
  so a harness can assert `hiddenPorts(cfg, model, 'cells')` vs `'agents'` without mutating a
  module global. An omitted `graph` resolves to the conservative CELL shape.
  `types.ts` takes a **type-only** import of `ActiveGraphKind` from `graphState.ts` (which imports
  nothing at all), so there is no runtime cycle.
- **THE COMPILERS GATE ON `CompileContext.agentGraph`, NOT on the port.** The port cannot be wired
  on a cell graph, but a hand-edited file could carry the edge — and the by-id emit references
  `_agentMaxAgents` / `highWater` / `_alive`, none of which exist in a cell ABI. So all three
  compilers take the self arm whenever `!agentGraph`. (`agentGraph` is TRUE for all five agent
  roots; `agentRoot` is not — it is undefined on the agent OM.)
- **BYTE-IDENTITY, and how it was made structural.** The new port reuses `setAgentAttribute`'s
  own port id (`agentId`), and every other port / config key (`attributeId`, `extraCount`,
  `attr_N`, `_port_value*`, `value_N`) already matched slot for slot — so
  [setAgentAttributeMigration.ts](src/model/setAgentAttributeMigration.ts) is a **PURE nodeType
  rename with ZERO handle rewrites** (the edges array is returned by IDENTITY). The wired arm of
  each emitter reproduces the retired node's output character-for-character (JS the `__sa` temp +
  the relaxed guard; WASM `emitGuardedAgentWrite`; WGSL the `saa` block). Result:
  `check-compile-identity` reports **29 models, all surfaces unchanged**, the 8 shipped
  `setAgentAttribute` usages (Game of Life on Agents, Growing Graphs ×3, Life on Bonds, both
  Particle Lifes, SDCA) included. Wired into the standard trio — `LOAD_MODEL`,
  `cloneMacroWithFreshIds`, `migrateForHarness` — and it runs BEFORE `migrateAgentAttributeSplit`,
  which is why that migration's node-type set needs only `setAttribute`.
- **THE GATE FIX THIS FORCED (and a latent bug it closed).** `setAttribute` joins
  `CROSS_AGENT_OVERWRITE` in the sync-mode compile gate, the WebGPU agent gate and
  `targetDiagnosis` — but the sync gate errored for ANY member, wired or not, so admitting the
  ubiquitous self `Set Attribute` would have broken all four shipped sync-agent models. It now
  **skips an UNWIRED id** (a self write is thread-own and can never race), mirroring what the
  WebGPU gate already did. That also fixes a real latent bug from `5ee1407`: a SELF `Set Velocity`
  or `Set Target Radius` in synchronous agent mode was rejected outright.
- **Multi-slot**: `setAttribute` joins `getAgentAttribute` in `expandMultiAttrs`' `fanPorts`, so a
  wired `Agent` FANS OUT to every slot clone (one node writes N attributes on ONE target). Unwired
  there is no edge to fan, so a self / cell write is untouched. `vectorAttr`'s `SET_LOWER` entry
  gains the same fan-out (`copyConfig` stays FALSE — the component clones must not inherit the
  parent's `_port_value`).
- **`nodeValidation`**: `setAttribute` moved from `AGENT_SELF_ONLY_TYPES` to
  `AGENT_SELF_ONLY_WHEN_UNWIRED` — wired, it is a by-id setter whose relaxed `_agentMaxAgents`
  guard IS in the Init ABI, so configuring a newborn on its handle is legitimate.
- **⚠ THE GET PAIR IS DELIBERATELY *NOT* CONSOLIDATED — a genuine technical asymmetry.**
  `getCellAttribute` is PURE (CSE-eligible, loop-invariant-hoistable); `getAgentAttribute` is
  impure (a neighbour's attribute is mutable mid-step). Merging them would make PURITY a
  per-INSTANCE, wiredness-dependent property across FOUR type-keyed classification sets —
  `accessorCSE`'s `NEVER_PURE_TYPES`, `loopInvariant`'s `NEVER_INVARIANT`, both agent compilers'
  `AGENT_VALUE_NO_HOIST`, and `asyncWriteHazard`'s reader seeds — where a mis-classification
  silently CSE-merges two reads across a write and produces wrong values with no error anywhere.
  WRITES have no such classification (a write is never a CSE source), which is exactly why the Set
  side consolidated cleanly. So the model is: **one `Set Attribute` (optional id), and a
  read-side pair `Get Self Attribute` / `Get Attribute (by ID)`** — the user's rule allows a pair
  "unless there is a strong technical reason not to", and this is one. (This paragraph originally
  added that `setAgentsAttribute` "stays a separate node either way" — **superseded**: the very next
  round folded the ARRAY write-many into the SAME `Agent` port, which simply takes an id or an id
  array. Only the READ pair survives, for the purity reason above.)
- **⚠ AN UNWIRED `Agent` ON A BY-ID NODE IS A SILENT 0 — AND IT IS NOW BADGED
  (`BY_ID_UNWIRED` in [nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts)).** Because the
  READ pair survives, `getAgentAttribute` renders as **"Get Attribute (by ID)"** on the Agents
  graph — which reads simply as "Get Attribute", so it is routinely dropped in where **Get Self
  Attribute** was meant. Every by-id node emits a missing id as the `-1` empty sentinel (the
  deliberate guard that keeps `_agentX[-1]` = undefined → NaN, and an adjacent-memory read on
  WASM, out of the engine), so the range guard resolves it to a **read of 0** (or a skipped
  write) on all three agent targets — plausible, wrong, and reported nowhere. **That was the
  root cause of BOTH user-reported Set Sprite bugs**: a `Scale` expression `a*b` whose `a` is
  such a read is always 0, so the sprite silently falls back to the asset scale ("unresponsive"),
  and the same reader on `Dir X`/`Dir Y` makes the vector-rotation write skip its own zero-vector
  guard ("the sprite never turns"). It also explains the reporter's "it works from an Init event"
  — there the Create Agent handle IS wired. `detectMissingConfig` badged an unwired `agentId` on
  **`getAgentAttribute` / `getAgentPosition` / `getAgentRadius` / `getAgentOffset` /
  `setAgentPosition` / `setAgentRadius`**, each message naming the self-reading alternative (the
  existing `getBondAttribute` / `getAgentsAttribute` precedent). **`getVelocity` / `setVelocity` /
  `setAttribute` / `setTargetRadius` / `killAgent` / `setAgentSprite` are deliberately EXCLUDED**
  — their unwired id means SELF, a documented default. Validation-only: zero compiler change,
  `check-compile-identity` 31/31 unchanged, and **0 false positives across all 31 shipped models**
  (none contains an unwired by-id node).
  **⚠ SUPERSEDED FOR THE THREE READERS (2026-09-02) — the badge was the right answer to a silent
  read of 0, but the SEMANTICS are the better one.** `getAgentAttribute` / `getAgentPosition` /
  `getAgentRadius` now MEAN self when unwired and are no longer badged; `getAgentOffset` /
  `setAgentPosition` / `setAgentRadius` (+ the newly-added `applyForceToAgent`) keep the badge,
  because none of them has a self meaning to default to. See the next section.
- **Verified**: `check-compile-identity` 29/29 unchanged · `test-cross-agent-writes` grew Parts D
  (the optional id: port visibility per graph, the self/wired emit on JS, both WASM modules
  differing, the WebGPU accept/reject split, and the CELL graph still emitting `w_c[idx]`) and E
  (the migration: type flip, config verbatim, edges by identity, idempotence, macroDefs, and —
  the load-bearing one — a migrated legacy graph emitting **byte-identical JS AND byte-identical
  WASM bytes** to a hand-authored node, with the multi-slot fan-out asserted). **Negative-
  controlled by SOURCE MUTATION — 4 mutations, 4 caught**: drop the `setAttribute` fan-out, force
  the emit to the self arm, make the migration a no-op rename, make the port always visible.
  Plus `parity-agent-wasm` (its multi-slot synthetic now exercises the consolidated node),
  `test-agent-abi` 629, `verify-graph-rewrite` 543, `test-c9-gates` 413, `test-geometry-taint`,
  `test-generation-pipeline`, `test-engine-resolve`, `test-agent-capabilities`,
  `test-vector-attr-compile`, `test-param-input-mappings`, `test-rule-cadence`,
  `parity-agent-force`, `audit-agent-layout`, `check-agent-wasm-gate`,
  `gen-capability-docs --check`. **Catalogue: 150 selectable / 53 agent.**
- **A stale harness check fixed in passing**: `test-rule-cadence` asserted the worker had exactly
  THREE `arityOk` sites; the input-mapping work had added a fourth long before this change, so it
  was failing on a clean checkout.

#### Retiring the `Set Agents Attribute` node — the `Agent` port takes an id or an id ARRAY (branch `polishing`, 2026-08-12)

The write side finished consolidating: `setAgentsAttribute` ("Set Agents Attribute", the write-many
over an id array) was **removed** and `Set Attribute`'s optional `Agent` port became
**SCALAR-OR-ARRAY**. User call: *"Why does 'Set Agents Attribute' not have the option to set
multiple attributes like the Set Attribute does? And also, why do we need to have two: one for
single, and one for a list of agents?"* — there was no strong technical reason, and the second node
additionally lacked MULTI-SLOT writes, so one node now covers **self / one agent / a whole group ×
N attributes**.

**THE THREE MODES, on one port**: `Agent` **unwired ⇒ this agent** · a **SCALAR** id ⇒ that agent ·
an **ID ARRAY** (Get Nearby / In View / Bonded Agents, Filter / Join Agents, Pick N Random Agents,
Sense Hemifield's two id ports, Get Agents Attribute, an array Local Variable) ⇒ **every id in it**.
The precedent is the lattice `setNeighborAttributeByIndex`, whose `index` port has taken a scalar or
an array since Wave A.

- **THE SHAPE IS A COMPILE-TIME DECISION, from ONE shared predicate.**
  **`isAgentIdArraySource`** ([compiler/agentIdArray.ts](src/modeler/vpl/compiler/agentIdArray.ts))
  is what all three agent compilers ask, so the same graph can never write different agents on
  different targets. It recognises exactly the two source shapes the retired node accepted: a
  statically `isArray` OUTPUT port, and an ARRAY-kind `getVariable` — the latter asked through the
  caller's OWN notion of "this variable is an array" (`model.variables`/`agentVariables` on JS,
  `ctx.arrayVarLocals` on WASM, `ctx.arrayVarNames` on WebGPU) so a compiler cannot disagree with
  its own array machinery. **A runtime `Array.isArray` test is NOT an option on WASM/WebGPU, and
  `(arr) | 0` silently resolves to agent 0** — the documented never-coerce-array→scalar trap.
  A `valueSwitch` ARRAY RELAY is deliberately NOT recognised (only JS resolves the relay; the two
  agent backends' type-based `AGENT_ARRAY_PRODUCERS` do not list it) — a pre-existing asymmetry
  shared by every agent array consumer, which this helper does not widen.
- **The JS compiler answers it once and hands it to the node as `config._agentIdIsArray`** (the
  `_indexesConnected` / `_leftAgentsUsed` convention — a fresh object, never stored on the node,
  `_`-prefixed so accessor-CSE's purity-key filter drops it; a flow node is never a CSE source
  anyway). The two agent backends call the predicate directly at their `setAttribute` case.
- **THE ARRAY ARM *IS* THE RETIRED NODE'S EMIT, MOVED — not rewritten.** JS reproduces the
  `_si<id>`/`_sa<id>` guarded loop character-for-character; WASM calls the same
  `emitSetAgentsAttribute` (now taking the port id) with its local-allocation ORDER untouched;
  WebGPU emits the same `sasK`/`sasId`/`sasV` block with the same `fresh()` ordering. That is what
  makes a migrated model's JS text, WASM BYTES and WGSL byte-identical.
- **⚠ THE TWO WIRED ARMS GUARD DIFFERENTLY, DELIBERATELY** (each keeps its retired node's semantics
  byte-for-byte, and the difference is justified): a **SCALAR** id may be a STAGED Create Agent
  handle (`alive = 0` until Add Agent To World), so it takes the relaxed **range-only**
  (`agentRootRelaxesGuard`) guard; an **ARRAY** comes from a live-agent query, so each id keeps the
  strict `< highWater && alive` guard outside the selfless roots (`agentRootHasSelf`).
- **MULTI-SLOT × ARRAY works through the EXISTING fan-out**: `multiAttrExpand`'s `fanPorts` already
  copies a wired `agentId` edge to every slot clone, so each clone loops the SAME array — one node
  sets N attributes on a whole group. Verified as ONE write-many loop per slot.
- **`arrayCapable: true`** on the port is the suggestion layer only (`isValidConnection` already
  permitted the wiring): dragging an id array off Get Nearby Agents now OFFERS Set Attribute in the
  compatible-nodes menu, both drag directions.
- **The gates needed one simplification, not a widening**: `CROSS_AGENT_OVERWRITE` (the sync-mode
  compile gate, the WebGPU agent gate and `targetDiagnosis`) dropped `setAgentsAttribute` and its
  `agents`-vs-`agentId` port ternary — an ARRAY-wired write rides the same `agentId` edge, so it is
  treated exactly like a scalar-wired one for free (async-only; WebGPU clamps to JS).
- **[setAgentsAttributeMigration.ts](src/model/setAgentsAttributeMigration.ts)** — a nodeType rename
  **plus ONE handle rewrite** (`input_value_agents` → `input_value_agentId`); everything else already
  matched slot for slot (`do`/`next`/`value`, the `_port_value` key, `attributeId`; the `value` port's
  dataType widens `float` → `any`, strictly more permissive). Node ids, edge ids and both array orders
  are preserved, which is what makes the emitted code byte-identical. Wired into the established trio —
  `LOAD_MODEL`, `cloneMacroWithFreshIds`, `migrateForHarness` — and it runs BEFORE
  `migrateAgentAttributeSplit`, which is why that migration's node-type set needs only `setAttribute`.
- **The READ side stays a pair, for the same technical reason recorded above**: `getCellAttribute`
  ("Get Self Attribute") is PURE and `getAgentAttribute` ("Get Attribute (by ID)") is not, and
  `getAgentsAttribute` (the array GATHER) returns a *values array*, not a write — a different shape,
  not a second spelling.
- **Verified**: `check-compile-identity` **29 models, all surfaces unchanged** (no shipped model or
  generator ever used the node — the byte-identity guarantee is for user files) ·
  `test-cross-agent-writes` grew Part F (the three modes on JS/WASM/WebGPU, `arrayCapable`, the
  registry removal, multi-slot × array, and the migration emitting **byte-identical JS + WASM bytes
  + WGSL** to a hand-authored node) · a permanent `[synthetic] Set Attribute agent id (self / scalar
  / ARRAY + multi-slot)` parity entry whose **VALUE invariant recomputes all three modes from the
  store** — slot 1 carries the WRITER's x and slot 3 the writer's y, so "wrote self" and "dropped
  the fan-out" are both distinguishable, and the fixture asserts PER SLOT that it can tell them
  apart. **Negative-controlled by SOURCE MUTATION — 5 mutations, 5 caught**: WASM-only skipping the
  first id (parity), dropping the `agentId` fan-out (parity-blind, caught by the invariant),
  forcing the shared predicate false (a loud compile failure), dropping the JS array arm, and a
  migration that forgets the handle rewrite. **Real UI / real worker**: an agents model where each
  agent marks EVERY nearby agent through one array-wired multi-slot Set Attribute matched an
  independent recount **40/40 exactly on JS and on WASM** (with 15-24 of 40 agents deliberately
  uncovered, so a self-write could not pass), a **legacy `.gcaproj` carrying the retired node**
  migrated on load and produced the identical 40/40, the WebGPU-target variant correctly **clamped
  to JS** with the documented reason, SYNCHRONOUS agent mode produced the named compile-gate error,
  the Palette lists exactly one **Set Attribute** and no **Set Agents Attribute**, and the
  connection-drop menu for an integer ARRAY output offers it. 0 console errors.
- **Catalogue: 149 selectable / 52 agent.**

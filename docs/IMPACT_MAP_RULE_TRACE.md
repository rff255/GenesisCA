# Impact Map — **Rule Trace** (trace one cell's / one agent's rule through the graph, live)

> **Status: design authority for [PLAN_RULE_TRACE.md](PLAN_RULE_TRACE.md) / `.html`.** Origin:
> [BRAINSTORM_RULE_TRACE.md](BRAINSTORM_RULE_TRACE.md). Written 2026-09-12 per the *Impact Map First*
> rule (this touches the compiler, the worker, the simulator view, the graph editor and the Live
> shell) after the *Read to CLOSURE* walk over `docs/areas/simulator-ui.md` (§ LIVE ×3, § viewer
> control) · `modeler-ui.md` (Key Patterns, § LIVE ×2) · `compiler-core.md` (sinking, CSE, volatile
> hoist, multi-attr, periodic events) · `simulation-engine.md` (the GPU-readback invariants, step
> batches, Grid Init, sparse stepping) · `agent-compilers.md` · `agent-render.md` (UI-sync policy) ·
> `engines-and-targets.md` · `macros.md` · `testing-harnesses.md` · `grid-3d.md` (inspect rings).
> **Anchors are `file:line` at commit `8c7f6d4` (branch `debug-mode`)**; they name the symbol too.

---

## 0. What is being built, and the one architectural claim

The chosen cell / agent's rule is **re-evaluated** each generation by a **trace build** of the JS
reference compile — the same graph, the same lowering passes, the same node emitters, plus per-node
**value records**, per-flow-node **execution records** and a **single-element body** — run in the worker
against the live state inside a **write-recording sandbox**. The engines (JS / WASM / WebGPU, 2D / 3D,
cells / agents) are **not instrumented and not changed**; the trace is a side computation.

| Locked in | Locked out |
|---|---|
| The trace build is `compileGraph` / `compileAgentGraph` **with an option** (D4), never a second walker | Instrumenting WASM / WGSL; a graph interpreter |
| Trace of the **current** state, before the generation is applied (D2); breakpoints pause *before* the step | Post-hoc traces of the previous state |
| One target per graph (cell target ↔ cell graph, agent target ↔ agent graph) | Multi-element tracing |
| Live-only entry (inspector **Trace** button, hidden elsewhere) | A Modeler / Simulator-tab surface |
| Event log shipped from the worker; **all** presentation (cursor, cones, tooltips) derived on the main thread (D3) | Worker-side presentation state |
| **Zero change to the normal emit** on every surface — proved by `check-compile-identity` | Any lowering-id renaming (see S2) |

---

## 1. Verdict table

| # | Subsystem | Impact | Risk | Files |
|---|---|---|---|---|
| S1 | JS compiler — `compileRoot` value/flow emit, the root wrappers, the pass switches | **High** — a `trace` option threads through `compileGraph` / `compileAgentGraph` and every root wrapper | ⚠⚠⚠ byte-identity of the normal build | `src/modeler/vpl/compiler/compile.ts` |
| S2 | Lowering passes — the **origin map** (lowered id → user node + port/component) | **Medium** — additive return field per pass, no id change | ⚠⚠ a pass without an origin = a node that never lights | `macroExpand.ts`, `expandComposites.ts`, `vectorAttr.ts`, `facingSource.ts`, `multiAttrExpand.ts`, `censusExpand.ts`, `periodicExpand.ts`, `forceToAgentsExpand.ts`, `densityExpand.ts`, `linkedOutputMappings.ts`, `agentLinkedOutputMappings.ts`, `accessorCSE.ts` |
| S3 | Worker — trace runner (sandbox), root registry, the per-generation hook, breakpoints + batch abort, GPU freshness | **High** — new messages, a hook in three batch loops, readback gating | ⚠⚠⚠ the GPU-mirror invariants; residency | `src/simulator/engine/sim.worker.ts`, new `src/simulator/engine/traceRunner.ts` |
| S4 | SimulatorView — target state, protocol, inspector buttons, canvas marks (2D+3D), inspect subscription, Live bar chip, lifecycle (recompile / reinit / load) | **High** | ⚠⚠ target lifecycle across the model effect's three arms | `src/simulator/SimulatorView.tsx`, `InspectCellPopover.tsx`, `InspectAgentPopover.tsx`, `src/live/LiveViewportBar.tsx` |
| S5 | Trace store + origin resolution (main thread) | **Medium** — new module, the `graphState.ts` pub/sub shape | ⚠ | new `src/trace/traceState.ts`, `src/trace/traceOrigin.ts` |
| S6 | Graph editor — node/edge highlighting, cursor, breakpoint glyph + context-menu item, hover tooltips, macro-scope mapping | **High** — must not re-render the graph per frame | ⚠⚠⚠ perf; the fixed-in-transformed-ancestor rule | `src/modeler/vpl/GraphEditor.tsx`, `CaNode.tsx`, `CaNode.module.css`, `GraphEditor.module.css` |
| S7 | The Trace panel (bottom drawer of the graph pane) | **Medium** — new component, transport, timeline, Values / Steps / Breakpoints | ⚠ keyboard ownership | new `src/trace/TracePanel.tsx`, `ModelerView.tsx` |
| S8 | Keyboard | **Low–Medium** — two new keys (`]` / `[`), all inside the existing stand-down discipline | ⚠ | `SimulatorView.tsx` or `App.tsx` |
| S9 | 2D vs 3D | **Medium** — the target mark on both canvases; the 3D inspector already opens the same popover | ⚠⚠ | `SimulatorView.tsx`, `render/gl3d.ts` |
| S10 | Agents on WebGPU (resident batches, stale store) | **Medium** — a trace target with breakpoints forces the per-generation path | ⚠⚠ | `sim.worker.ts` |
| S11 | Persistence / `.gcaproj` | **None** — breakpoints are session state (D8) | ✓ | — |
| S12 | Harnesses + identity gate | **Medium** — a new value harness; the trace surfaces join `check-compile-identity` | ⚠ | `scripts/test-rule-trace.mjs`, `scripts/check-compile-identity.mjs`, `src/dev/compileHarness.ts` |
| S13 | Docs | new area doc + routing row + Help + README + handoff | ✓ | `docs/areas/rule-trace.md`, `CLAUDE.md` (one row), `src/help/HelpView.tsx`, `README.md` |
| S14 | Normal emit on every target | **ZERO** | ✓ (must be *proved*) | — |

---

## 2. S1 — the compiler's trace option

### What is there now

- `compileRoot` (`compile.ts:424`) returns `{ valueLines, preLoopValueLines, flowLines, scratchNodes }`.
  Value nodes emit through **one funnel**, `routeValueEmit(nodeId, code)` (`:620`), called from
  `compileValueNode` (`:834`) with the node's whole emitted text; consumers read a node's variable via
  `varName(sourceNodeId, portId)` (`:733`) — `_v<id>`, `_v<id>_<port>` for multi-output, `_scr_<id>` for
  `getNeighborsAttribute`, `_v<id>_vals` for `getNeighborsAttrByIndexes`.
- Flow nodes emit inside `compileFlowChain` (`:1073`): the control kinds (`conditional` `:1112`,
  `loop` `:1164`, `forEachInArray` `:1200`, `forEachBond` `:1240`, `createAgent` `:1289`, `switch`
  `:1351`) push their own lines; every other flow node goes through `def.compile` at `:1428`; the
  `next` continuation is `compileFlowChain(node.id, 'next', indent)` at `:1434`.
- Root wrappers: step (`:2196`–`:2300`, async order loop / sync loop / sparse dual loop), init, gridInit,
  inputColor (per-cell, `idx` a parameter, `:2336`), outputMapping (`:2401`), agent behaviour
  (`:3025`), division (`:3080`), agentInit (`:3128`), agent OM (`:3219`), agent IM (`:3275`).
- Pass switches already exist for exactly the two things trace mode must turn off: CSE
  (`canonicalizeAccessorEdges` `:1843` / `:2841`) and aggregate fusion (`detectFusableConsumers`
  `:2105` — note the sparse mode already passes empty graphs to disable fusion).

### The change

`compileGraph(nodes, edges, model, opts?: { trace?: boolean })` and `compileAgentGraph(…, opts?)`.
With `trace: true`:

1. **Records.** `compileValueNode` appends, after the node's own code, one `_tr.v("<id>","<port>",<var>)`
   per value-output port that the node actually declares — computed from the same port list `varName`
   resolves against (static `def.ports` + the dynamic builders the editor uses: extra slots, census,
   bond-attr ports, input-mapping parameters). **Undeclared ports must not throw**: a port that is
   emitted only when consumed (`myVolume`, `:3021`) or only in some config is guarded with
   `typeof <var> !== 'undefined'`. `compileFlowChain` pushes `_tr.f("<id>")` before a flow node's code and
   `_tr.o("<id>","<port>")` at the entry of every branch body it opens (`then` / `else` / `body` /
   `case_N` / `default` / each `then_i`) and before the `next` continuation. Root value-outs emitted by
   the wrappers (`_v<bsId>_myX…`, `initEvent`'s coords, `gridInit`'s `width/height/depth`, input-mapping
   parameter channels) get records in the wrapper.
2. **Single-element body.** The per-element loop is replaced by `const idx = _traceIdx;` (a trailing
   parameter) for step / init / outputMapping / agent behaviour / agent OM; `inputColor`, division and
   the agent IM already take `idx`; gridInit / periodic / agentInit / spawner are global — traced whole.
   **No bulk copy** (`bulkCopyLines`), **no sparse dual loop**, **no linked-indicator embedding**
   (`linked.*`), **no `_rngState[0] = _rs` write-back** (the sandbox hands a private RNG cell anyway).
   Everything else in the body — `decodeCoordLines`, `subAttrSyncCopyLines`, `variableBlocks`,
   `viewerHoistLines`, `preLoopValueLines` — is kept verbatim so the traced body IS the engine's body.
3. **Pass switches.** CSE off (each duplicate accessor materialises its own record); fusion off (the
   gather materialises so its array is recordable). Sinking, loop-invariance, volatile hoisting, the
   async hazard: **unchanged** — a value sunk into an untaken branch has no record, which is the truth.
4. **The result** gains `trace?: { paramNames: Record<rootKey, string[]>; origin: Record<loweredId, TraceOrigin> }`
   so the worker can name its args and the UI can map records back (S2, S5).
5. **Parameter list**: the trace function's params are the normal root's params **plus** `_traceIdx`
   (where applicable) and `_tr` — appended, so `buildLoopArgs` / `buildAgentLoopArgs` / … are reused
   verbatim by the runner with two extra trailing args (params ≤ args is the safe direction already
   documented for `generation`, `sim.worker.ts:4928`).

### ⚠⚠⚠ Trap 1 — the normal build must be byte-identical

Every new line is behind `opts.trace`. Proof: `node scripts/check-compile-identity.mjs --compare` must say
**31 models, all surfaces unchanged** after S1 lands. The **trace surfaces** are then ADDED to the
identity script (`js.traceStepCode`, `js.traceAgentBehaviourCode`, …) so the trace emit gets its own
regression net — "a surface it does not hash is a surface with no regression net at all"
(`testing-harnesses.md`).

### ⚠⚠ Trap 2 — TDZ and re-emitted bodies

`compileFlowChain` inlines a flow node's body at **every** walk (flow diamonds, `compiler-core.md` §
"Flow graphs are DAGs"), and the `compiled` set dedups value emission across walks. A record appended to
a value node's code therefore appears once per *emission*, which is right. A record must never reference
a `const` declared **later in the same block** (`typeof` throws in the TDZ) — hence records are appended
to the node's own code, never hoisted, and the wrapper's root-port records sit after the wrapper's
declarations.

### ⚠ Trap 3 — arrays are reused scratch

`_scr_<id>` and `_v<id>_vals` are scratch typed arrays reset at use site. `_tr.v` must **copy** (bounded,
e.g. the first 64 elements + the true length) at record time or every record of that node would show
the final contents.

---

## 3. S2 — the origin map (lowered id → user node)

The trace records carry **lowered** ids. Five passes already follow one convention —
`<originId>__<tag>…`: `multiAttrExpand.ts:241` (`__ma`), `censusExpand.ts:147` (`__cn`),
`periodicExpand.ts:89` (`__ps`), `forceToAgentsExpand.ts:43` (`__afa`), `densityExpand.ts:163` (`__dn`).
Macros prefix `m<instanceId>_` (`macroExpand.ts:63`), nested by recursion. Three do **not**:
`expandComposites.ts:126` (`__vec<n>`, a bare counter), `vectorAttr.ts:364` and `facingSource.ts:65`
(`nid()`), and `linkedOutputMappings.ts` synthesises whole colour passes with no user node at all
(`mkLinkedNode`, `:130`).

**Decision: no id is renamed** (a rename changes emitted text and can flip CSE's "lexicographically
smallest id" canonical choice — an emit change on WASM/WGSL too). Instead each pass gains an
**additive `origin` map in its return value** (`Map<loweredId, { nodeId, portId?, component? }>`), and
`compileGraph(…, {trace:true})` folds them, in pass order, into one `origin` table (composing through
macro prefixes: an origin inside a macro is `{ nodeId: <innerId>, macroPath: [instA, instB…] }`).
`accessorCSE` is off in trace mode, so it contributes nothing. A lowered id **absent** from the table and
not a user id is a **harness failure** (S12), not a silent dark node.

Composite ports (`vector` / `color`) resolve to N component records with `component: 'x'|'y'|'z'` /
`'r'|'g'|'b'|'a'`; the UI reassembles `(x, y, z)` for the user's port.

---

## 4. S3 — the worker: sandbox, roots, hook, breakpoints

### The sandbox (new `src/simulator/engine/traceRunner.ts`, DOM-free so the Node harness runs it)

`runTrace(fn, args, paramNames, opts) → TraceResult`. Every argument is wrapped by **kind**:

| Arg kind | Wrapper | Why |
|---|---|---|
| typed array / `Array` | **shadow proxy**: numeric `get` → shadow if written else the base; `set` → shadow only; `length` → base; `.set` / `.fill` / `.copyWithin` / `.sort` / `.reverse` → no-op; `.subarray` / `.slice` → **must not be reachable** (the runner throws on first use so a new emitter cannot silently escape the sandbox) | reads of the current cell after a write see the write (the async `r === w` alias and `fromWriteBuffer` reads), other cells read live state, nothing is applied |
| plain object (`_indicators` is a `Float64Array` — proxied; `linkedResults` `{}`, `cachedModelAttrs`, `cachedInteractionTables`) | shallow copy, and one level of array copies | read-mostly; a write must not leak |
| function (`_agentCreate`, `_agentAddToWorld`, spawn closures) | recording stub (`-1` / no-op) that logs a **request** event | Create Agent inside a trace must not spawn |
| number / string / boolean / `null` | pass-through | |

`rngState` is a private one-element copy seeded from `(elementIdx, generation)` (D1's stable re-trace).
After the run the shadow maps are read back **by parameter name** into the result's `writes` (own-cell
attribute writes → `next` values; other indices → *neighbour write*; agent SoA fields → forces / velocity
/ radius / requests; `_stopFlag`, `_skipped`, glyphs, colours, fields, indicators). The event log is
capped (`TRACE_MAX_EVENTS = 5000`) with `truncated: true`.

**The methods the emitted code calls on params are finite** — grep of `src/modeler/vpl/nodes/*.ts`
shows `.set(` / `.fill(` (scratch fills and the bulk copy, both handled) and array `.slice` / `.indexOf`
/ `.includes` on **compile-time** arrays only. The runner's throw-on-escape is the guard for the
future.

### The root registry

| Root key | Fn | Args builder | Element | When it is traced |
|---|---|---|---|---|
| `step` | trace of `stepCode` | `buildLoopArgs()` + `[idx, tr]` | cell | before a generation (see cadence) |
| `init` | `initCode` | `buildLoopArgs()` + `[idx, tr]` | cell | on Reset / first init, for the target cell |
| `gridInit` | `gridInitCode` | `buildLoopArgs()` + `[tr]` | global | on Reset, once |
| `gridPeriodic:<id>` | each `gridPeriodicCodes[i]` | `buildLoopArgs()` + `[tr]` | global | when `gridPeriodicDue()` fires it |
| `inputColor:<mappingId>` | `inputColorCodes[i]` | `[...channels, ...buildCellArgs(idx), tr]` | cell | a `paint` / `importImage` that covers the target |
| `outputMapping:<mappingId>` | `outputMappingCodes[i]` | `buildLoopArgs(false)` + `[idx, tr]` | cell | after the step trace, for the ACTIVE viewer only |
| `agentBehaviour` | `behaviourCode` | `buildAgentLoopArgs(s)` + `[id, tr]` | agent | before a generation |
| `agentInit` / `agentPeriodic:<id>` | `initCode` / `periodicCodes[i]` | `buildAgentInitArgs(...)` + `[tr]` | global | on Reset / when due |
| `agentDivision` | `divisionCode` | `buildDivisionArgs(s, id, 0, …)` + `[tr]` | agent | when the target agent divides (daughter 0) |
| `agentOutputMapping:<mid>` | `outputMappingCodes[i]` | `buildAgentLoopArgs(s, mid)` + `[id, tr]` | agent | after the behaviour trace, active agent viewer |
| `agentInputMapping:<mid>` | `inputMappingCodes[i]` | `[...channels, ...buildAgentInputArgs(...)]` + `[tr]` | agent | a paint that hits the target agent |

The builders are the worker's existing ones (`sim.worker.ts:4888` `buildLoopArgs`, `:4934`
`buildCellArgs`, `:2214` `buildAgentLoopArgs`, `:1981` `buildDivisionArgs`, `:1875` `buildAgentInitArgs`,
`:2001` `buildAgentInputArgs`) — the trace params are those lists **plus trailing args**, so the
mirror discipline is inherited, not duplicated.

### ⚠⚠⚠ Trap 4 — the GPU-mirror invariants (`simulation-engine.md` § "read the GPU down first")

A trace reads `readAttrs` / the `AgentStore`. Under the WebGPU grid target `gpuOwnsAttrs` is true after
every GPU step (`:5460`), and under GPU-resident agents `agentStoreStale` (`:1366`). **Every trace call
site is preceded by `await ensureCpuAttrsFresh()` (`:5003`) / `await ensureAgentStoreFresh()` (`:1450`)
when the flags say so** — the trace runner is a READER, never a writer, so it never re-arms
`gpuOwnsAttrs = false` on its own; it calls the existing one-shots, whose cost is the documented
W·H·D readback. This is the whole reason for the cadence rule below.

### The cadence (D5) and the hook

- **Sampled** (default while playing): one trace per root **per batch**, taken at the batch END on the
  post-batch state = the pre-step state of the next generation, i.e. *the board on screen → what it
  does next*. One readback per frame on WebGPU, which the inspect popover already pays
  (`postInspectCellsData` is fed by `finalizeStepWebGPU`'s forced `wantColors`, `:6926`).
- **Every generation** (only when the main thread says so: breakpoints exist, or the user is stepping):
  inside each batch loop, **before `runStep()` / the agent step of a generation**, trace → if a
  breakpoint id appears in the event log, **stop the batch there** (the generation is NOT run), post
  `stepped` + `traceBreak { root, gen, nodeId }`, and remember `traceBreakGen = generation` so the next
  `step` message runs that generation without re-breaking (a breakpoint fires once per generation).
  Three batch loops carry the hook: the sync JS/WASM loop (`runOneGeneration`, `:7960` region), the
  WebGPU grid loop (`:7560`+), and the per-generation agent-WebGPU loop. **The GPU-resident agent batch
  cannot host a per-generation hook** — S10.
- **On demand** (`requestTrace`): when the target is set, after a paint / paste / reset / recompile /
  `loadState`, and whenever the simulation is paused — the trace of the board on screen.

### ⚠⚠ Trap 5 — batch abort semantics = `cancelStep`'s

Breaking out of a batch must **not** leave queued `step` messages to replay (`simulation-engine.md` §
"the non-obvious half"): the break path filters `deferredDuringAsyncBatch` exactly as `cancelStep` does
(drop reqId-less `step`s, keep Overseer ones). The Overseer never traces (Live excludes it).

### Messages (additive)

`setTrace { target, codes?, breakpoints, everyGen }` · `requestTrace` · `clearTrace`; worker →
`trace { root, gen, target, events, writes, truncated, approximate }` · `traceBreak { root, gen, nodeId }`
· `traceTargetLost { reason }` (agent died / cell out of range after a resize).

---

## 5. S4 — SimulatorView: the target's lifecycle

- **Entry**: `InspectCellPopover` (`:18248`, `:18289` render sites; `commitInspectPopover` `:11420`,
  3D via `openInspect3dRef` `:11440`) and `InspectAgentPopover` (`openAgentInspector` `:11793`; the
  Follow toggle at `:16605` is the template — `following` / `onToggleFollow` → `tracing` /
  `onToggleTrace`) gain a **Trace** button rendered only when `live` (prop). The sweep (transient)
  popovers do not get it (a transient inspector is about to be discarded — the Follow precedent).
- **State**: `traceTargetRef` (leads) + `traceTarget` state (renders), the `followAgentIdRef` discipline
  (`:2925`). The target is also **subscribed as an inspect cell** (merged into the `setInspectCells`
  post, `:8901`) / **polled as an agent** (merged into `agentInspectIds`, `:3445`) so the *current*
  values keep flowing after the popover is closed.
- **Marks**: 2D cell — an outline in the trace accent in the overlay draw (`:5352` ring block is the
  agent template; the cell outline the sweep inspector draws is the cell template); 3D cell — through
  `r.setInspectCells` (`:6363`) with a distinct style; 2D agent — a ring like Follow's accent (`:5363`);
  3D agent — `r.setInspectAgents` (`:6508`).
- **Lifecycle across the model effect** (`simulator-ui.md` § `appliedModelRef`): soft recompile →
  recompile the trace codes and re-post `setTrace` (target kept); full reinit → cell target kept iff
  `idx < newTotal`, agent target dropped (population re-seeded); model load / New → dropped. The trace
  compile runs **only while a target exists** (it is a second JS compile of the graph).
- **Live bar chip**: `LiveViewportBar` gets `traceLabel` / `onStopTrace`; rendered only in Live (the
  bar only exists in Live). Stopping tracing clears the target, the marks, the panel and the highlight.
- **Playing state**: `traceBreak` → `setPlaying(false)` through the same `useEffect([playing])` seam
  that posts `cancelStep` (`simulation-engine.md`), so the pause is the ordinary pause.

---

## 6. S5 — the trace store (main thread)

`src/trace/traceState.ts`: the `graphState.ts` shape (private `let`, getter, `subscribe`,
equality-guarded setter). Holds `target`, the **timeline** (a ring of the last 40 traces, keyed by
root + generation), `selected` (which trace the graph shows), `cursor` (`null` = whole trace, else an
index into the selected trace's **flow** events), `breakpoints` (per graph kind, user node ids →
resolved lowered-id sets), `origin` (from the last trace compile), and derived selectors:
`nodeStatus(userNodeId) → { executed, current, records }` and `edgeStatus(edgeId)`. `TracePanel`,
`GraphEditor` and `CaNode` consume it. `src/trace/traceOrigin.ts` resolves lowered ids to
`{ nodeId, macroPath }` and answers "is this record visible in the current editor scope" (root scope:
`m<inst>_…` rolls up to the instance node; inside `inst`: strip the prefix; nested likewise).

---

## 7. S6 — the graph editor

### ⚠⚠⚠ Trap 6 — no React re-render per frame

A trace arrives up to 30×/s. Highlighting through React Flow's `nodes` / `edges` state would re-render
the whole layer each time. So: **one subscriber in `GraphEditor` toggles CSS classes imperatively** on
`.react-flow__node[data-id]` (the id the editor already queries at `GraphEditor.tsx:544`) and
`.react-flow__edge[data-id]`, diffing the previous set against the next (`traceHit`, `traceCurrent`,
`traceFlowTaken`, `traceValueLit`). `CaNode` reads nothing per frame; it subscribes only to
**breakpoints** (a static set) to draw the red dot, via `useSyncExternalStore` (the `showPortLabels`
precedent, `modeler-ui.md` Key Patterns).

### Hover tooltips

`onNodeMouseEnter` / `onEdgeMouseEnter` (React Flow props, unused today) → a tooltip **portalled to
`document.body`** with `position: fixed` (the *Fixed inside a transformed ancestor* rule). Content: the
node's port records at the cursor (or the latest), decoded by type (bool → true/false, tag → option
name, NI → `(dr, dc)`, composite → `(x, y, z)`, array → `[a, b, c, …] (n)`), or for an edge the source
port's value. No `role="menu"` (hover surfaces must not own the keyboard — the viewer-control lesson).

### Breakpoint toggle

The node context menu (`GraphEditor.tsx:5813` region) gains **Breakpoint** (toggle) in Live only
(outside Live the trace cannot run → hide). `CaNode` draws the glyph. Breakpoints inside a macro scope
are keyed by `macroPath + innerId`, so the same macro instanced twice can carry different breakpoints.

### Macro scopes

`currentScope` (`GraphEditor.tsx:857`) decides the mapping: the highlight set is recomputed on scope
change from the same trace.

---

## 8. S7 — the Trace panel

A drawer along the **bottom of `.graphArea`** (`ModelerView.tsx:414`), mounted only while a target exists
(D7), resizable by a top handle (the `PanelShell` drag discipline — mutate `style.height` during the
drag, commit on release), height persisted in `genesisca_trace_panel` (its own key: `genesisca_sim_settings`
belongs to `SimulatorView`'s persist effect, `simulator-ui.md`). Content: transport row · timeline
strip · tabs **Values / Steps / Breakpoints**. It carries `role="region"` — **not** `role="dialog"` or
`role="menu"`, which would make `overlayOwnsKeyboard()` stand the global `Enter` down for the whole
session.

Doctrine table (hide / grey / enabled) per control is in the plan §5.

---

## 9. S8 — keyboard

`]` = step node, `[` = back one node, only while a trace target exists, from either pane, standing down
for `isTypingTarget()` / `overlayOwnsKeyboard()` / the capture review — the Phase-4 gate (`simulator-ui.md`
§ INPUT OWNERSHIP). Bound **once** (in `App`, the Live shell), never in both views (the `Ctrl+C/V/X`
double-binding lesson). `Enter` (play/pause) and `Space` (one generation) are unchanged and already do
"Resume" / "Step generation".

---

## 10. S9 — 2D vs 3D

The trace itself is dimension-blind (a flat `idx`). The UI has two consumers per dimension: the target
mark (S4) and the inspector entry (`openInspect3dRef` opens the same `InspectCellPopover`, so the button
is shared). Verify on Life3D + Accretor (3D) and Game of Life + Wireworld (2D), a 3D agent model
(Particle Life 3D) and a 2D one.

---

## 11. S10 — agents on WebGPU

- **Per-generation tracing needs the CPU store fresh every generation**, which the GPU-resident batch
  never provides (it reads back once per frame, `agent-render.md` FP-2). So `agentResidentEligible()`
  (`sim.worker.ts:3327`) gains a runtime term: `!(traceTarget?.kind === 'agent' && traceEveryGen)` —
  a breakpoint session on a resident model runs the per-generation path (slower, correct). Sampled
  tracing keeps residency and reads the store at the frame boundary through `ensureAgentStoreFresh()`.
- The trace target counts as a **state-reading feature** for the UI-sync driver (`agent-render.md`, the
  `setAgentUiSync` want-terms) so the snapshot keeps flowing for the mark and the popover.

---

## 12. S12 — harnesses

- **`scripts/test-rule-trace.mjs`** (values, negative-controlled): (1) for every shipped model the
  trace build compiles for every root, every lowered id resolves through the origin table; (2) on
  deterministic sync models (Game of Life, Wireworld, Life3D, Gray-Scott, a multi-attr synthetic) the
  trace's own-cell `writes` for a set of cells **equal the real JS step's post-state** for those cells,
  and the flow records match the branch the real body took; (3) the sandbox never leaks: the real
  buffers hash-identical before and after a trace; (4) an agent model (Boids) traces through
  `runTrace` with `buildAgentLoopArgs`-shaped args and its recorded force equals the force the JS
  behaviour writes; (5) breakpoint matching; (6) event cap. Negative controls: mutating the record
  emitter / the shadow `set` trap must fail the named check.
- **`check-compile-identity.mjs`**: the normal surfaces unchanged (the S1 proof) + the new
  `trace*` surfaces added.
- Existing gates rerun: `parity-agent-wasm`, `verify-agent-render`, `verify-sparse-stepping`.

---

## 13. The top traps, in one place

1. **Byte-identity of the normal build** (Trap 1) — everything behind `opts.trace`; the identity gate is the proof.
2. **GPU mirrors** (Trap 4) — every trace reads through `ensureCpuAttrsFresh` / `ensureAgentStoreFresh`; never re-arm the flags from the runner.
3. **Batch abort = cancelStep** (Trap 5) — drop queued reqId-less `step`s on a break.
4. **No per-frame React re-render** (Trap 6) — imperative class toggling keyed by `data-id`.
5. **The sandbox must not escape** — every arg wrapped by kind, `.subarray`/`.slice` throw, functions stubbed.
6. **Origin coverage** — a lowered id with no origin is a harness failure, never a dark node.
7. **Keyboard roles** — the panel is `role="region"`; the tooltip has no role; the two new keys are bound once.

---

## 14. Where the request's assumptions were adjusted

- *"The last inspected cell/agent is the debugged one"* → an explicit **Trace** button, as the request itself
  went on to prefer (the Follow precedent) — inspecting is far more frequent than tracing.
- *"Links/nodes glow indicating the flow… as the element is executing"* → a generation runs in
  microseconds; the glow shows the **path the last trace took**, refreshed per frame, and the **cursor**
  replays it node by node — the LabVIEW "highlight execution" idea rather than literal real time.
- *"Breakpoints… resume, step one node"* → breakpoints pause **before** the generation is applied (the
  board shows what the rule read); *step node* is a cursor over the recorded log, *step generation* is
  the transport's own Step.

---

## 15. Reading trail

`simulator-ui.md` (§ LIVE Phase 2/3/4, § viewer control, § inspect-related items) → `modeler-ui.md`
(Key Patterns: pub/sub, `data-id`, fixed-in-transformed-ancestor, `role="menu"`; § LIVE) →
`compiler-core.md` (sinking, CSE, volatile hoist, multi-attr, periodic) → `simulation-engine.md` (GPU
readback invariants, interruptible batches, Grid Init, sparse) → `agent-compilers.md` (the agent
compiler + ABI mirror discipline) → `agent-render.md` (UI-sync want-terms, residency) →
`engines-and-targets.md` (Auto / WASM / WebGPU resolution) → `macros.md` (expansion ids, scopes) →
`grid-3d.md` (3D inspect rings) → `testing-harnesses.md` (house style). Nothing further turned up on the
last pass.

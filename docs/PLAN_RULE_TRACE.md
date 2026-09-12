# Plan — **Rule Trace** (trace one cell's / one agent's rule through the graph, live)

> **Status: plan.** Design authority: [IMPACT_MAP_RULE_TRACE.md](IMPACT_MAP_RULE_TRACE.md) (traps by
> number) · origin [BRAINSTORM_RULE_TRACE.md](BRAINSTORM_RULE_TRACE.md) (decisions D1–D10) · illustrated
> companion [PLAN_RULE_TRACE.html](PLAN_RULE_TRACE.html) (the entry gesture, the lit graph, the cursor,
> the panel, the breakpoint pause, the tooltip). Branch `debug-mode`, base `8c7f6d4`.
>
> **P0 is delivered:** `PLAN_RULE_TRACE.html` exists — a self-contained illustrated companion (inline CSS +
> inline SVG, no external assets) with eleven sections: the shape · the entry gesture · the lit graph · the
> cursor · the Trace panel · the breakpoint pause storyboard · how it works (trace path vs production path,
> and the cadence) · the hide/grey/enabled doctrine table · 2D vs 3D and cells vs agents · what the trace
> cannot promise · the delivery order.
>
> Vocabulary: the feature is **Rule Trace**; the button is **Trace**; the pause point is a
> **breakpoint**; the controls are **Resume · Pause · Step generation · Step node · Back one node**.

---

## 0. The shape of the thing

```
Live ─┬─ graph pane ──────────────────────────────┬─ simulation pane ─────────────────┐
      │  [ nodes lit along the executed path ]     │  board · target cell outlined      │
      │  [ red dot = breakpoint ]  hover → values  │  Live bar: ◉ Tracing cell (12,34) ✕│
      ├── Trace panel (bottom drawer) ─────────────┤  inspector popover: [Trace] button │
      │ ⏵ ⏸ ⏭ ⤓ ⤒ │ gen 412·Step ▸ gen 412·OM ▸ … │                                    │
      │ Values | Steps | Breakpoints               │                                    │
      └────────────────────────────────────────────┴────────────────────────────────────┘
```

### The invariants this feature must never break

| # | Invariant | Comes from |
|---|---|---|
| I1 | **The normal emit is byte-identical on every surface** (`check-compile-identity`: 31 models, all surfaces unchanged). | Impact map Trap 1 |
| I2 | **The trace never writes engine state.** Every argument is wrapped by kind; the real buffers hash-identical around a trace. | Trap 4/5 of the map, D1 |
| I3 | **A trace reads fresh state** — `ensureCpuAttrsFresh` / `ensureAgentStoreFresh` precede it under GPU ownership; the runner never clears those flags itself. | `simulation-engine.md` readback invariants |
| I4 | **A breakpoint pauses BEFORE the generation is applied**, fires once per generation, and breaking a batch drops queued reqId-less `step`s (the `cancelStep` rule). | D2, Trap 5 |
| I5 | **No React re-render per trace** in the graph editor — imperative class toggling by `data-id`. | Trap 6 |
| I6 | **Every lowered id resolves** through the origin table (harness-enforced). | S2 |
| I7 | **Live-only surfaces are hidden elsewhere**; temporarily-unavailable controls grey with the reason. | UI doctrine |
| I8 | **2D and 3D, cells and agents, JS / WASM / WebGPU** — every phase verifies both dimensions and (where the phase touches it) all three targets. | CLAUDE.md |

### Phase map (one Opus session each, in this order)

| Phase | Delivers | Depends on |
|---|---|---|
| **P0** | The illustrated plan (`PLAN_RULE_TRACE.html`) | — |
| **P1** | Compiler trace option + origin maps + `traceRunner.ts` (DOM-free) + `scripts/test-rule-trace.mjs` + identity surfaces | — |
| **P2** | Worker: root registry, messages, cadence hook in the three batch loops, breakpoints, GPU freshness, residency term, lifecycle | P1 |
| **P3** | SimulatorView + inspectors + Live bar chip + canvas marks (2D/3D) + the trace store + origin resolution + keyboard | P2 |
| **P4** | Graph editor: highlight classes, cursor, breakpoint glyph + menu, hover tooltips, macro scopes | P3 |
| **P5** | The Trace panel (transport, timeline, Values / Steps / Breakpoints) | P4 |
| **P6** | Docs: `docs/areas/rule-trace.md`, CLAUDE.md routing row, HelpView chapter, README line, project-structure, HANDOFF | P5 |
| **P7** | Adversarial review (read-only, findings ranked) → fix session | P6 |

### P0 decisions (settled after drawing the mockups — the UI phases inherit these)

| # | Question the mockup raised | Decision |
|---|---|---|
| A1 | Trace button: icon chip or labelled button? | An **icon chip** (the Follow chip's size and placement), with a distinct inline-SVG glyph — a three-dot stepped path, never a filled circle that could be read as Follow's `◎` — and the tooltip carrying the words: *"Trace this cell's rule in the graph (Live)"*. |
| A2 | Breakpoint glyph on a red-headed node | A red dot **with a white ring** (readable on every header colour). |
| A3 | Timeline strip in a narrow drawer | **Horizontal scroll, never wrap**; the newest entry is scrolled into view when it arrives unless the user has selected an older one. |
| A4 | The trace accent colour | A new theme token `--color-trace` (magenta family, e.g. `#d05ce3` / theme-tuned) — distinct from Follow's accent orange and the breakpoint red. Used by the target mark, the chip, the lit path and the cursor pulse. |
| A5 | A key for "Whole trace" | None — mouse only (`]` / `[` remain the only new keys). |
| A6 | Values tab row order | Declaration order; changed rows **accented**, never re-sorted (a row that jumps is harder to follow across generations). |
| A7 | The worked example | Death by overcrowding (`count = 4`) so the tooltip, the Values table and the storyboard tell one story. |

---

## 1. P1 — the compiler trace option, the origin maps, the runner, the harness

### 1.1 `compile.ts`

- `export interface CompileOptions { trace?: boolean }`; `compileGraph(nodes, edges, model, opts?)`,
  `compileAgentGraph(nodes, edges, model, stopIdxBase?, opts?)`. `compileRoot` takes `trace: boolean`.
- **Records** (`_tr` is the trailing param; `TraceRecorder` is typed in `traceRunner.ts`):
  - `compileValueNode`: after `code` is produced (both the fused and the normal arm; fusion is OFF in
    trace mode so only the normal arm matters, but keep the fused arm correct too), append
    `_tr.v("<nodeId>","<portId>", typeof <var> === 'undefined' ? undefined : <var>);` for each value
    output port. The port list = `getEffectivePorts`-equivalent for the node **as the compiler sees it**
    (static `def.ports` + `buildExtraSlotPorts` + `buildCensusPorts` + `buildBondAttrPorts` +
    `buildInputParamPorts` for the roots) — resolve each through `varName(nodeId, portId)` so the record
    names exactly the identifier consumers use. Single-output nodes record port `value` (or the def's
    only output port id).
  - `compileFlowChain`: `_tr.f("<nodeId>");` before the node's code; `_tr.o("<nodeId>","<port>");` at
    the top of every branch body the walker opens and before the `next` continuation. For `switch`,
    `case_N` / `default`; for `sequence`, each `then_i`; for `loop`/`forEach*`, `body` per iteration and
    `next` after; for `conditional`, `then` / `else`.
  - Root wrappers: records for the root's own value-outs (`behaviourStep` `my*`, `initEvent` coords,
    `gridInit` dims, input-mapping channels, `forEachBond`'s per-iteration outs already sit inside the
    flow walk).
- **Single-element bodies**: replace the loop with `const idx = _traceIdx;` (+ `if (!_alive[idx]) return;`
  for agent loops) in step / init / outputMapping / agentBehaviour / agent OM. Drop `bulkCopyLines`, the
  sparse dual loop, `linked.*`, and the trailing `_rngState[0] = _rs`. Keep everything else verbatim.
- **Pass switches**: in trace mode skip `canonicalizeAccessorEdges` and call
  `detectFusableConsumers([], [], …)` (the sparse precedent).
- **Result**: `CompileResult.trace?: TraceCompileMeta` = `{ paramNames: Record<TraceRootKey, string[]>,
  origin: Record<string, TraceOrigin> }`; same on `AgentCompileResult`. Root keys as in the impact map
  §4. `paramNames` come from the same builders (`buildLoopParams` etc.) split on `, `.
- **Byte-identity**: `opts` absent ⇒ every existing code path untouched. Prove with the identity gate.

### 1.2 The origin maps (S2)

Each lowering pass's return gains `origin?: Map<string, TraceOrigin>` (`{ nodeId, portId?, component?,
macroPath?: string[] }`). `expandMacros` returns the prefix map (`m<inst>_<inner>` → `{nodeId: inner,
macroPath: [inst]}`, composed through recursion). `compileGraph`/`compileAgentGraph` fold every pass's
map in order, translating an origin whose `nodeId` is itself a lowered id (a pass after a pass). The
composite lowering records `component`. A helper `resolveTraceOrigin(id, table)` walks until it lands on
a user id (or a macro path) and is exported for the UI (P3) and the harness.

### 1.3 `src/simulator/engine/traceRunner.ts` (DOM-free, imported by the worker AND the harness)

`runTrace({ fn, args, paramNames, elementIdx, generation, maxEvents }) → TraceResult`:
`{ events: TraceEvent[], writes: TraceWrite[], truncated, error? }` with
`TraceEvent = ['v', id, port, value] | ['f', id] | ['o', id, port] | ['q', kind, detail]` (`q` = a request
from a stubbed function). `value` is a number, a bounded plain-array copy `{ arr, len }`, or `undefined`.
The wrapping rules are the impact map §4's table; `.subarray` / `.slice` on a wrapped param **throw**
`TraceSandboxEscape`. `writes` = every shadow entry, keyed by param name + index. RNG: a private
`Uint32Array(1)` seeded from `(elementIdx, generation)`.

### 1.4 `scripts/test-rule-trace.mjs` (esbuild-bundled like the others)

Checks §12 of the impact map, negative-controlled by source mutation (at least: the record emitter, the
shadow `set` trap, the origin fold). Add the trace surfaces to `compileHarness.ts` + `check-compile-identity.mjs`.

**Verify**: `npx tsc -p tsconfig.app.json --noEmit`, `node scripts/check-compile-identity.mjs --compare`
(baseline captured at `8c7f6d4` BEFORE editing), the new harness, `parity-agent-wasm.mjs` unchanged.

---

## 2. P2 — the worker

- Module state: `traceTarget`, `traceFns: Map<rootKey, {fn, paramNames}>` (eval'd from `codes`),
  `traceBreakIds: Set<string>` (lowered ids), `traceEveryGen`, `traceBreakGen`, a per-root
  `traceSeq`.
- Messages: `setTrace` (target + optional codes + breakpoints + everyGen), `requestTrace`, `clearTrace`.
  A `setTrace` with codes re-evals; without keeps them.
- `traceRoot(rootKey, buildArgs, elementIdx?)`: guards (fn present, element alive / in range), `await`
  freshness under GPU ownership (I3), run `runTrace`, post `trace`. `traceCurrentState()` = step (+ OM
  for the active viewer) for a cell target, behaviour (+ agent OM) for an agent target.
- Hooks: batch END (sampled) in all three loops + `sendColors`-adjacent single post; **before** each
  generation when `traceEveryGen` (the three loops), with the break: on a hit, skip the generation,
  drop queued reqId-less `step`s, post `stepped` then `traceBreak`, set `traceBreakGen`; the next batch
  skips the check for `generation === traceBreakGen`. Reset / init → `init`, `gridInit`, `agentInit`
  traces. `paint` / `paintManual` / `importImage` covering the target cell → `inputColor:<mid>`. Agent
  paint hitting the target → `agentInputMapping:<mid>`. Periodic events when they fire. Division of the
  target agent → `agentDivision` (daughter 0).
- Residency term in `agentResidentEligible()` (S10); the target keeps `agentUiSync` state flowing.
- Target loss: agent dead / cell ≥ total → `traceTargetLost`, target cleared worker-side.
- **Verify** in the real browser (the dev harness + `window.__simWorker`): Game of Life on WASM and on
  WebGPU (trace values match the inspector's next values; a breakpoint on the `Set Attribute` pauses
  before the step; resume fires once per gen), Life3D (3D idx), Particle Life on WebGPU agents (resident
  → per-gen under breakpoints, sampled keeps residency), Chemotaxis (grid + agents, E2 composite), an
  async model (Snake — `approximate` flag). Real buffers unchanged around a trace (hash).

---

## 3. P3 — SimulatorView, inspectors, Live bar, marks, the store, keys

- `src/trace/traceState.ts` + `src/trace/traceOrigin.ts` (impact map §6). The store owns the timeline
  ring (40), `selected`, `cursor`, breakpoints (keyed `graphKind + macroPath + nodeId`), the origin table,
  and the selectors. `setTraceTarget` / `clearTrace` / `pushTrace` / `setCursor` / `stepCursor(±1)` /
  `toggleBreakpoint`.
- SimulatorView: the target ref+state; the **Trace** button on both inspectors (Live only, pinned
  popovers only); the merged inspect subscription / agent polling; the 2D/3D marks; the Live bar chip;
  the lifecycle across the model effect's arms (soft recompile → recompile trace codes + `setTrace`;
  full reinit → keep cell target iff in range, drop agent target; load/new → clear); `traceBreak` →
  pause through the `playing` seam; `traceTargetLost` → clear + a toast-style message on the chip.
- The trace compile is run **only while a target exists**, alongside the normal compile, and its
  `origin` table is pushed to the store.
- Keys `]` / `[` bound once in `App` under the Phase-4 stand-down gate; `Enter` / `Space` unchanged.
- **Verify** (real UI, 0 console errors): both entry points on 2D and 3D models; the chip; marks on 2D
  cell / 3D cell / 2D agent / 3D agent; closing the popover keeps tracing; target survives a node edit
  and a paint; a dimension change keeps / drops correctly; a model load clears everything; Simulator
  tab shows no Trace button; the keys step the cursor from either pane and stand down in a text field.

---

## 4. P4 — the graph editor

- `GraphEditor`: one subscription → diff sets → `classList` on `.react-flow__node[data-id]` /
  `.react-flow__edge[data-id]` (`traceHit` / `traceCurrent` / `traceFlowTaken` / `traceValueLit`),
  recomputed on trace change, cursor change, scope change and graph kind change; cleared on unsubscribe.
  Executed = has a record ≤ cursor (or any, when the cursor is null). The current flow node's value cone
  (transitive value inputs, from the editor's edges) is lit at its latest records ≤ cursor.
- Breakpoint glyph in `CaNode` (a red dot on the header's left; `useSyncExternalStore` on the
  breakpoint set only); context-menu item **Breakpoint** (toggle) in Live.
- Hover tooltips: `onNodeMouseEnter` / `onEdgeMouseEnter` → a portalled fixed tooltip, typed decoding,
  no role. Hidden while dragging / connecting.
- Macro scope mapping per `traceOrigin`; a macro instance node on the root scope lights when any inner
  node executed; entering the scope shows the inner path.
- **Verify** (real UI): Game of Life (path lit, cursor stepping `]`/`[`, tooltip values on a node and a
  wire), Wireworld (a Switch — only the taken case lit), a macro model (Kelp War — instance lights,
  inner path inside), Particle Life (agent graph), a Loop model (per-iteration records; cursor walks
  iterations). Measure: no React commit in GraphEditor per trace (React DevTools profiler / a render
  counter), 30 traces/s on a 300-node graph without frame drops.

---

## 5. P5 — the Trace panel

`src/trace/TracePanel.tsx` (+ `.module.css`), mounted by `ModelerView` under `.graphArea` while a
target exists. Transport: **Resume ⏵ / Pause ⏸** (the simulator's `playing`), **Step generation ⏭**
(the transport's step), **Step node ⤓ / Back ⤒** (cursor), **⟲ Whole trace** (cursor null). Timeline
strip: the ring's entries newest-right, `gen N · <root label>`, the selected one marked; selecting
loads it into the graph. Tabs:
- **Values** — for a cell: every attribute (name, current → next, changed rows accented; type-decoded;
  orientation, colour/glyph, neighbour writes, indicator writes, stop event, skipped); for an agent:
  attributes, position/velocity/radius, total force, requests (divide / kill / bond form / break /
  rewire / create), field deposits, sprite. A header line: `Trace of generation 412 (step) ·
  approximate under asynchronous updates` when applicable; `truncated` badge.
- **Steps** — the flow events in order (`▸ If (energy > 3) → then`), click = cursor there; value
  records collapsed under their consumer.
- **Breakpoints** — the list with node label + scope, enable/disable, remove, clear all.

Doctrine: Resume/Pause always enabled; Step node / Back **greyed** at the ends with the reason; the panel
itself is **absent** without a target (hide); "Whole trace" greyed when the cursor is already null.
`role="region"`, never dialog/menu. Height persisted in `genesisca_trace_panel`.

**Verify** (real UI): every control on Game of Life + Particle Life; values match the inspector one
generation later on a deterministic model; timeline shows Brush and Output Mapping entries after a
paint; Init after Reset; the panel does not steal `Enter`.

---

## 6. P6 — docs

`docs/areas/rule-trace.md` (invariants I1–I8, the traps, the protocol, the root registry, the sandbox
rules, the cadence, the origin rule, the doctrine table, verification recipe) · one routing row in
`CLAUDE.md` (`src/trace/**`, `traceRunner.ts` → `rule-trace.md`) · `docs/areas/project-structure.md`
(`src/trace/`) · `simulator-ui.md` / `modeler-ui.md` / `simulation-engine.md` / `compiler-core.md` /
`agent-render.md` `Also read` lines + a short cross-reference paragraph each · `HelpView.tsx` (a Live
sub-chapter "Trace a cell or an agent") · `README.md` (one clause in the Live sentence) ·
`docs/HANDOFF_RULE_TRACE.md` (the build narrative + measurements). `node scripts/check-claude-md-budget.mjs`.

---

## 7. P7 — adversarial review, then fixes

A read-only session reviews the whole diff against I1–I8 and the impact map's traps, tries to break the
sandbox (a node emitting `.subarray`, a write to `_indicators`, `Create Agent` in a trace), the cadence
(breakpoint + G/F 200 on WebGPU), the lifecycle (target across reinit / load / Live exit), 2D/3D, and
the keyboard roles; reports findings ranked. A fix session closes every confirmed finding and re-runs
all gates.

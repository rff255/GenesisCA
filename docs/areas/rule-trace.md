# Rule Trace — watching one element's rule execute

> Area doc for **GenesisCA**. Pick one cell or one agent in **Live** and watch its rule run through the
> graph: the executed path lights up, hovering a node or a wire shows the values it carried, a bottom
> drawer lists `current → next` for every attribute, and breakpoints pause the run *before* a generation
> is applied. Read before touching `src/trace/**`, `src/simulator/engine/traceRunner.ts`,
> `traceProtocol.ts`, `src/modeler/vpl/compiler/traceOrigin.ts`, `simTransportState.ts`, or the `trace`
> option in `compile.ts`.
>
> **Also read** — a change here usually reaches [`simulator-ui.md`](simulator-ui.md) ·
> [`modeler-ui.md`](modeler-ui.md) · [`simulation-engine.md`](simulation-engine.md) ·
> [`compiler-core.md`](compiler-core.md) · [`agent-render.md`](agent-render.md) ·
> [`macros.md`](macros.md) · [`testing-harnesses.md`](testing-harnesses.md).
> Keep following those onward until a pass turns up nothing new; the reading is not done at the first
> doc that answers your question. See *Read to CLOSURE, not to the first hit* in `../../CLAUDE.md`.
>
> The build narrative — phases, measurements, the adversarial review's findings, the deviations from the
> plan — is [`../HANDOFF_RULE_TRACE.md`](../HANDOFF_RULE_TRACE.md). The design authority is
> [`../IMPACT_MAP_RULE_TRACE.md`](../IMPACT_MAP_RULE_TRACE.md), its origin
> [`../BRAINSTORM_RULE_TRACE.md`](../BRAINSTORM_RULE_TRACE.md) (decisions D1–D10), the illustrated
> companion [`../PLAN_RULE_TRACE.html`](../PLAN_RULE_TRACE.html).
>
> **Paths here are repo-root-relative** (e.g. `src/trace/traceState.ts`). Read them from the repository
> root; they will not resolve as links from this directory.

**Contents**

- [What it is, and the one architectural claim](#what-it-is-and-the-one-architectural-claim)
- [Vocabulary](#vocabulary)
- [The invariants I1–I8](#the-invariants-i1i8)
- [The trace build (`compile.ts`, `opts.trace`)](#the-trace-build-compilets-optstrace)
- [The origin table](#the-origin-table)
- [The sandbox (`traceRunner.ts`)](#the-sandbox-tracerunnerts)
- [The worker](#the-worker)
- [The main thread](#the-main-thread)
- [The graph editor](#the-graph-editor)
- [The Trace panel](#the-trace-panel)
- [UI doctrine — every control](#ui-doctrine--every-control)
- [What the trace cannot promise](#what-the-trace-cannot-promise)
- [Verification recipe](#verification-recipe)
- [Known limitations and follow-ups](#known-limitations-and-follow-ups)

---

## What it is, and the one architectural claim

The chosen element's rule is **re-evaluated** each generation by a **trace build** of the JS reference
compile — the same graph, the same lowering chain, the same node emitters, plus per-node value records,
per-flow-node execution records and a **single-element body** — run in the worker against the live state
inside a **write-recording sandbox**. The production engines (JS / WASM / WebGPU, 2D / 3D, cells /
agents) are **not instrumented and not changed**; the trace is a side computation costing one element's
worth of work.

⚠ **This is what makes the feature ALL-TARGET by construction rather than by effort.** Nothing on the
trace path knows which engine is running the model, so there is no target to "port it to later" and no
clamp to add — the same standing as the Grid Init Event and the Agent Init Event, which are JS-on-CPU on
every target. `engines-and-targets.md` therefore has nothing to say about it: the Engine radio does not
change what a trace shows, only how fast the generation around it runs.

The trace is of the **CURRENT** state — *the board you see → what it does next* — computed before a
generation is applied. That is why a breakpoint pauses **before** the step: the board on screen is the
state the rule read.

## Vocabulary

Used identically in the UI, the Help chapter and these docs.

| Term | Means |
|---|---|
| **Rule Trace** | the feature |
| **Trace** | the button / the chip on both inspectors; the noun for one recorded run of the rule |
| **Tracing cell (r, c)** / **Tracing agent #id** | the Live-bar chip's label (`(layer L, r, c)` in 3D) |
| **breakpoint** | a mark on a node that pauses the run when the traced element reaches it |
| the controls | **Resume · Pause · Step generation · Step node · Back one node · Whole trace** |
| **the cursor** | a position in the selected trace's **flow** events; `null` = show the whole trace |
| **the timeline** | the ring of recent traces, one chip each (`gen N · Step`, `gen N · Division`, …) |

## The invariants I1–I8

From `PLAN_RULE_TRACE.md`. Each one names what enforces it and what proves it.

| # | Invariant | Enforced by | Proved by |
|---|---|---|---|
| **I1** | **The normal emit is byte-identical on every surface.** | Every trace line sits behind `opts.trace`; the helpers return `''` when it is absent. | `check-compile-identity --compare`: 31 models, all surfaces unchanged. The six **trace** surfaces are on that list too, with their own baseline. |
| **I2** | **The trace never writes engine state.** | Every argument wrapped by kind in `runTrace`; methods deny-by-default. | `test-rule-trace.mjs` § D hashes every buffer around a batch of traces; § F drives the escape. |
| **I3** | **A trace reads fresh state.** | Every trace call site is preceded by `ensureCpuAttrsFresh()` / `ensureAgentStoreFresh()` when the GPU-ownership flags say so. ⚠ The runner is a READER and **never clears those flags itself**. | `simulation-engine.md` § *read the GPU down first*; the live WebGPU / resident-agent scenarios. |
| **I4** | **A breakpoint pauses BEFORE the generation is applied**, fires once per generation, and breaking a batch drops the queued reqId-less `step`s (the `cancelStep` rule). | `traceBreakGen` + the break path's deferred-message filter; `traceBreakPending` rides the earlier `stepped`. | 40/40 resumes advance exactly one generation (GoL/WebGPU at G/F 148); the board hash is unchanged across a break. |
| **I5** | **No React re-render per trace** in the graph editor. | ONE `subscribeTrace` subscriber writing a `data-trace` **attribute** by `data-id`; `CaNode` subscribes only to the SESSION channel with a primitive snapshot. | React commits per generation 1.018 with tracing vs 1.017 without, on a 300-node graph at ~44 traces/s. |
| **I6** | **Every lowered id resolves** through the origin table. | The additive per-pass `origin` maps, folded in pass order. | `test-rule-trace.mjs` § A over every shipped model — an unresolved id is a **harness failure**, never a silently dark node. |
| **I7** | **Live-only surfaces are hidden elsewhere**; temporarily-unavailable controls grey with the reason. | See [UI doctrine](#ui-doctrine--every-control). | The doctrine table; `0 dialog/menu roles` present while the panel is open. |
| **I8** | **2D and 3D, cells and agents, JS / WASM / WebGPU.** | The trace itself is dimension-blind (a flat `idx`); the four marks and the NI codec are the only per-dimension code. | The live matrix in the [verification recipe](#verification-recipe). |

## The trace build (`compile.ts`, `opts.trace`)

`compileGraph(nodes, edges, model, opts?)` / `compileAgentGraph(…, opts?)` with `{ trace: true }`. The
TRACE BUILD header sits at the top of `compile.ts` and is the authority; the short version:

**Records.** Each value node appends `_tr.v("<nodeId>","<portId>", …)` per declared value-output port to
**its own emitted code**; each flow node gets `_tr.f("<nodeId>")` before it and `_tr.o("<nodeId>","<port>")`
at the top of every branch body the walker opens and before its `next`. `_tr` is a trailing parameter
(a `TraceRecorder`, typed in `traceRunner.ts`). Ports come from the same list `varName` resolves against
— static `def.ports` plus the dynamic builders the canvas uses (extra slots, census, bond-attr ports,
input parameters) — and are `typeof`-guarded for ports a config never declares.

⚠ **TDZ.** A record is APPENDED to the node's own code and **never hoisted**. A record above a `const`
in the same block touches it in its temporal dead zone, where even `typeof` throws.

⚠ **Scratch arrays.** `_scr_<id>` / `_v<id>_vals` are REUSED. The recorder copies them (bounded to
`TRACE_MAX_ARRAY = 64` elements plus the true length) **at record time**, or every record of that node
would show the final fill.

**The single-element body.** The per-element loop becomes `{ const idx = _traceIdx; … }` (`_traceIdx` is
the parameter before `_tr`) for step / init / output mapping / agent behaviour / agent OM; `inputColor`,
division and the agent input mapping already take their element, and the global roots (grid init,
periodic, agent init) take `_tr` only. The sparse dual loop, the linked-indicator embedding and the
`_rngState[0] = _rs` write-back are dropped.

⚠ **The bulk `w.set(r)` copy becomes a SINGLE-CELL copy, not nothing.** Dropping it outright traced
`updateAttribute`'s read-modify-write **wrong** — an attribute the rule does not write must still be
there to read. The harness caught it on Extended Wireworld; it is the deviation most likely to be
"simplified" back out by someone who reads only the plan.

**Pass switches.** Accessor-CSE is skipped (each duplicate accessor materialises its own record) and
aggregate fusion is disabled (the gather materialises so its array is recordable). **Sinking,
loop-invariance, volatile hoisting and the async hazard are UNCHANGED** — a value sunk into an untaken
branch simply has no record, which is the honest picture of that element.

**`paramNames`.** `CompileResult.trace.paramNames` maps each root key to the emitted function's FULL
parameter list, in order, including the appended `_traceIdx` / `_tr`. The runner names its sandbox
wrappers from it — it is the only way it can tell `_rngState` from a cell attribute buffer.

**The root keys have ONE definition**, in `src/modeler/vpl/compiler/traceOrigin.ts`, because the compiler
is the side that WRITES them; `traceProtocol.ts` re-exports the lot so the engine side imports them
unchanged. ⚠ They were spelled by hand in three places until P7b, and a key built under one spelling and
prefix-filtered under another **fails silently**: the periodic root never pairs with its code and that
trace simply goes missing with no error anywhere.

| Root key | Element | Traced when |
|---|---|---|
| `step` | cell | the cadence (see below) |
| `init` | cell | on Reset / first init |
| `gridInit` | — (global) | on Reset, once |
| `gridPeriodic:<nodeId>` | — (global) | when the worker's own `generation % period === phase` test fires it |
| `inputColor:<mappingId>` | cell | a paint / manual paint / image import covering the target cell |
| `outputMapping:<mappingId>` | cell | after the step trace, **active viewer only** |
| `agentBehaviour` | agent | the cadence |
| `agentInit` | — (global) | on Reset |
| `agentPeriodic:<nodeId>` | — (global) | when due |
| `agentDivision` | agent | when the target agent divides — ⚠ **daughter A only** (`ev.a`), because A reuses the mother's slot and is therefore the id the user is watching; B is a brand-new slot they never selected, and tracing both would post two conflicting traces of one root in one generation |
| `agentOutputMapping:<mappingId>` | agent | after the behaviour trace, active agent viewer |
| `agentInputMapping:<mappingId>` | agent | a paint that hits the target agent |

⚠ **THE ROOT IS FLOW EVENT 0.** `compileRoot` emits `_tr.f(root)` plus a wired-guarded `_tr.o(root, port)`
once, ahead of the flow chain. Before P7b no `f` record ever named the root — its body *is* the wrapper —
so a breakpoint on a root node could never fire while still forcing the every-generation cadence and its
GPU readback. The Steps tab lists it, the cursor lands on it, and P4's editor-side synthesis of the root
became an idempotent fallback.

## The origin table

The records carry **lowered** ids — after macro expansion, composite / vector / multi-attr / census /
periodic / density / force-broadcast lowering and the synthesised linked colour passes. The editor only
knows the ids the user placed.

⚠ **No id is ever renamed to make this work.** A rename changes emitted text on every target and can
flip accessor-CSE's "lexicographically smallest id" canonical pick. Instead **each lowering pass returns
an additive `origin` map** (`TraceOriginMap`) and `compileGraph` / `compileAgentGraph` fold them in pass
order into one `TraceOriginTable`. Eleven passes carry one: `macroExpand`, `expandComposites`,
`vectorAttr`, `facingSource`, `multiAttrExpand`, `censusExpand`, `periodicExpand`, `densityExpand`,
`forceToAgentsExpand`, `linkedOutputMappings`, `agentLinkedOutputMappings`. Accessor-CSE is off in trace
mode, so it contributes nothing.

- The fold **translates as it goes**: a pass that synthesises from a node an EARLIER pass synthesised
  lands on the user node, not on the intermediate.
- `resolveTraceOrigin(id, table)` walks until it lands on something the table does not translate
  further, cycle-guarded. **A user id — one with no entry — resolves to ITSELF**, so no caller
  special-cases "this record was already a user node".
- **Composite ports** resolve to N component records carrying `component: 'x'|'y'|'z'|'w'|'r'|'g'|'b'|'a'`;
  the UI reassembles `(x, y, z)` / `(r, g, b, a)` for the user's port.
- **Linked colour passes have no user node at all.** They resolve to the sentinel
  `linked:<mappingId>` (`linkedOriginId` / `isLinkedOrigin`) — the MAPPING is the origin.

⚠ **A lowered id absent from the table and not a user id is a HARNESS FAILURE** (`test-rule-trace.mjs`
§ A), never a silently dark node. A new lowering pass that forgets its `origin` map does not break the
build; it makes a node stop lighting up, which nobody notices.

### ⚠ Two id spaces — and mixing them is the trap

A record's `macroPath` (from `expandMacros`) names macro **INSTANCE** node ids. The graph editor's scope
stack names macro **DEF** ids, because entering a macro edits the shared definition. So:

- the **visibility** test (*is this record inside the scope I am looking at?*) must run in **DEF** space —
  otherwise nothing inside any macro ever lights;
- the **answer** (*which node id do I light?*) must stay in **INSTANCE** space — a def id names no node
  on the canvas.

`originInScope` (`src/trace/traceOrigin.ts`) is the ONE prefix rule — the scope must be a prefix of the
record's macro path — and `originInEditorScope` (`traceGraphMap.ts`) delegates to it after translating
through the macro def index. At the root scope a record inside a macro lights the **instance node**;
inside the instance the inner node lights; one level deeper it lights the **nested instance node**, never
the whole remaining path.

The consequence is deliberate: **inside a macro def, the records of EVERY instance of that def light** —
they are the same nodes. **Breakpoints are keyed by the DEF path** for the same reason, so a mark set
inside a def arms in every instance (see [Known limitations](#known-limitations-and-follow-ups)).

## The sandbox (`traceRunner.ts`)

DOM-free on purpose: the worker imports it, and so does `scripts/test-rule-trace.mjs`.

`runTrace({ fn, args, paramNames, elementIdx, generation, maxEvents, sharedProxies })` → `{ events,
writes, truncated, error? }`. Every argument is wrapped **by kind** before the call:

| Arg kind | Wrapper |
|---|---|
| typed array / `Array` | **shadow proxy** — an indexed read sees a write made in THIS trace, every other index reads live state, and nothing lands on the base array. `length` reads the base; `Symbol.iterator` iterates **through the proxy's own numeric get**, so `for..of` sees the shadow. |
| plain object | shallow copy + one level of array copies (`modelAttrs`, `_linkedResults`, `_lookupTables`, `cachedInteractionTables`) |
| function | recording stub that logs a `['q', name, args]` event; `_agentCreate` returns `-1`, its documented "no slot" answer, so a traced spawn configures nothing |
| `_rngState` | **REPLACED**, not wrapped: a private one-element stream seeded by `traceRngSeed(elementIdx, generation)` |
| primitive / `null` / `undefined` | pass-through |

### ⚠ Identity aliasing, and the one place it must be off

**The same array object passed under two parameter names gets ONE shadow** (`sharedProxies`, default
true), so a self-read after a self-write sees the write — exactly the single-buffer semantics the engine
has under **asynchronous cells** (`r_x === w_x`), the **default async agent attributes**, and **always**
the division fn. Two independent shadows de-alias what the model deliberately aliases (it broke the
Snake's turn).

Set it **false** only where the CPU aliases what the engine does not: the **WebGPU sync grid**, which
dropped its separate CPU write buffer for memory (`attrWriteAliased`) while the GPU still has two. There
the trace must keep reads pre-state and writes shadowed apart.

⚠ **The write-side name wins the entry.** An aliased buffer's `param` used to be whichever name reached
it first — always the READ name, because every ABI lists the `r_<id>` block before the `w_<id>` block.
The Values tab keys a row's NEXT value by `w_<id>`, so every own-element write under those three
conditions was filed under `r_…`: the table said *"unchanged"* while dumping the real answer into the
unknown-row fallback. Renaming here, rather than teaching every consumer to try both names, keeps ONE
write and ONE row under the name that means *what this element would become*.

### ⚠ The method policy is DENY BY DEFAULT

The proxy intercepts indexed reads and indexed writes; a **method call does neither**. Until P7b the
`get` trap fell through to `Reflect.get(...).bind(target)` — every method ran against the REAL base
array, and `.push` / `.splice` on a wrapped plain Array wrote **straight through** the sandbox (measured:
`[1,2,3,4]` → `[1,2,3,4,99]`). A read-only method bound to the base is the same lie more quietly: it
answers pre-state for an index this trace already wrote.

- `NOOP_METHODS` = `set` / `fill` / `copyWithin` / `sort` / `reverse` are deliberate **no-ops**.
- **Every other function-valued property throws `TraceSandboxEscape` when CALLED.** Reading it is
  harmless (so a `typeof arr.push === 'function'` guard in future emitted code still answers truthfully);
  the throw happens on the call.
- **There is deliberately NO read-only allow-list.** No shipped node emitter calls any method on a
  *parameter* — every `.indexOf` / `.sort` in emitted code is on a `_scr_<id>` scratch array declared
  INSIDE the function, which is never wrapped. **To teach the sandbox a read-only method, implement it
  over this proxy's own numeric gets — never `.bind(target)`.**

`TraceSandboxEscape` is a **programming error, not a user condition**: it means a node emitter started
calling a method on a parameter. `runTrace` rethrows it (every other throw is captured into
`result.error`), the worker treats it as a breach, and the session ends with
`traceTargetLost { kind: 'both' }`.

### The arg-count cut

⚠ The engine deliberately passes **more** args than some roots declare — `_generation` is pushed
unconditionally while its parameter is gated (`params <= args` is the safe direction). For a normal call
an extra trailing arg is ignored; here it would **shift `_traceIdx` / `_tr` past the declared slots** and
the body would call `_tr.v` on a number. So the wrapped list is cut (or hole-padded) to exactly the
declared parameter count before the trace args are appended. `trailing` is 2 when the second-to-last
param is `_traceIdx`, else 1.

### After the run

Every shadow entry becomes a `TraceWrite { param, index, value, prev }` — `prev` is the live value, so
the UI can show `3 → 5`. The event log is capped at `TRACE_MAX_EVENTS = 5000` with `truncated: true`;
`events` is then a **prefix** of what the element did.

## The worker

The worker evals every trace root into a registry keyed by the compiler's own root keys, and runs each
through the sandbox against the **LIVE buffers via the engine's own arg builders** (`buildLoopArgs`,
`buildCellArgs`, `buildAgentLoopArgs`, `buildDivisionArgs`, `buildAgentInitArgs`, `buildAgentInputArgs`)
plus the trailing trace args. ⚠ **The ABI-mirror discipline is inherited, not duplicated** — a second
arg-list implementation would be free to drift from the engine's.

It holds **no presentation state** (decision D3): it posts an event log, and the cursor, the value cones
and the tooltips are all derived on the main thread. **Zero cost when off** — every hook opens on
`traceArmed()` (`traceCellTarget !== null || traceAgentTarget !== null`), one null test per batch.

The registry is `traceFns: Map<TraceRootKey, TraceFnEntry>`, each entry carrying `fn`, `paramNames`,
`kind` (`'cell' | 'agent' | 'global'` — does this root take an element?), `side` (`'cell' | 'agent'` —
which graph, and therefore **which freshness one-shot precedes it**), the periodic `period` / `phase`,
and three **static approximation markers scanned ONCE off the emitted text** at install time:
`usesRng`, `usesIndicatorWrite`, `usesAgentHash`. A root whose code ships without a parameter list, or
whose `eval` throws, is **collected** into `traceCompileErrors` and never rethrown (the `compileFns`
posture).

⚠ `kind` is not what decides the trailing args — `runTrace` reads that off `paramNames`. `inputColor`,
division and the agent input mapping declare their own `idx` and take only `_tr`.

### The protocol (`traceProtocol.ts`)

Main thread → worker:

| Message | Notes |
|---|---|
| `setTrace { target, codes?, breakpoints?, everyGen? }` | ⚠ `target` is the **COMPLETE INTENT, never a delta**: one target sets that kind and clears the other, an array sets both, `null` clears both. Clearing KEEPS the compiled fns, so resuming costs no re-eval. `codes` absent ⇒ keep the fns (a breakpoint / cadence change costs nothing); present ⇒ re-eval every root, per-root failures come back as `traceCompileErrors`. `breakpoints` are **already-lowered** ids — the main thread owns the origin table, the worker only does set membership. |
| `requestTrace` | ⚠ **No sender at present.** Setting a target used to post it right after `setTrace`, whose handler already ends in `scheduleTraceOfCurrentState()` — two identical traces of every root, two entries in the ring. Kept as the seam a "re-trace now" gesture needs; **a future sender must check whether the state-changing message it follows already schedules a trace.** |
| `clearTrace` | Drop the target, the fns, the breakpoints — the whole session. |

Worker → main thread:

| Reply | Payload worth knowing |
|---|---|
| `trace` | `seq` (monotonic; the UI drops an out-of-order arrival), `root`, `gen`, `target`, `events`, `writes`, `truncated`, `snapshot?`, `approximate`, `approximateReason?`, `error?` |
| `traceBreak` | `root`, `gen` (**the generation that was NOT run**), `nodeId` (the LOWERED id that matched) |
| `traceTargetLost` | ⚠ `kind: 'cell' \| 'agent' \| 'both'` **on the protocol** — `'both'` only for a sandbox breach, which ends the session. Explicit so the main thread never infers the kind from the prose `reason`. |
| `traceCompileErrors` | Per-root eval failures. A trace build that fails to eval is a **compiler bug**, so it is surfaced rather than swallowed. |

⚠ **`snapshot` is a correctness requirement, not an optimisation.** The event log says what the rule
COMPUTED and `writes` say what it WOULD write; neither says what the element's attributes are RIGHT NOW,
and the Values tab's whole shape is `current → next`. It is read **at the trace point**, beside the
writes: a later main-thread `getState` answers at some other time, and a trace taken before generation N
must be paired with the state of generation N — the state the rule actually read. Keyed by attribute id
for a cell (plus `orientation` when variegated); for an agent, by attribute id plus the engine field
names the agent inspector uses (`x`, `y`, `z`, `vx`, `vy`, `vz`, `radius`, `targetRadius`, `age`,
`bondDegree`, `density`). Absent for a global root, which has no element.

### The three cadences

| Cadence | When | Where |
|---|---|---|
| **Sampled** (default while playing) | one trace per root **per batch**, taken at the batch END on the post-batch state = the **pre-step state of the next generation** — *the board on screen → what it does next* | all three batch loops + the G/F-1 path |
| **Every generation** (opt-in) | **before** each generation, with the breakpoint test on `f` and `v` records | the same three loops; armed only when the main thread says so (breakpoints exist) |
| **On demand** | after every state-changing message, coalesced through a microtask | the message handlers |

The sampled hook is `traceAfterBatch()` at the tail of the three batch loops; the G/F-1 synchronous path
uses an inline guard instead (it must trace **in line**). The every-generation hook is
`traceBeforeGeneration()` / `…Sync()` at the **very top of the generation** — before the periodic events,
before the agent step, before the cell dispatch. On demand is `scheduleTraceOfCurrentState()`, coalesced
through `queueMicrotask` and driven from a `TRACE_RETRACE_TYPES` set tested at the very end of
`self.onmessage`.

⚠ **`paint` and `reset` are deliberately ABSENT from `TRACE_RETRACE_TYPES`** — both finish on an
asynchronous arm under WebGPU and schedule the re-trace from their own continuation instead (Reset's
WebGPU arm chains it after `finalizeStepWebGPU`, because the trace may itself owe a readback). `step` is
absent because the batch loops own their own cadence.

⚠ **The sampled cadence is throttled**: `TRACE_SAMPLE_MIN_MS = 100` (10 Hz) **with a trailing edge**.
A tiny WebGPU 3D grid at G/F 1 runs ~1900 generations/s, so the sampled hook was firing ~1900×/s — a
GPU→CPU readback stall, a `trace` message and a panel render each time (~30 % throughput). 10 Hz is above
the eye's ability to follow a changing values table and below the rate at which the readback matters. The
**trailing edge** is not optional: the last batch before a pause must still reach the panel, or the table
would sit up to 100 ms stale exactly when the user stopped to read it. One timer at a time, and
`traceCurrentState` re-checks every guard so a timer outliving its session is a no-op.

⚠ **ONLY the sampled cadence is throttled.** Every-gen and on-demand are untouched. Measured on Life3D
24³ at max rate: **−12.0 % with the throttle vs −20.2 % without**.

### ⚠ The breakpoint break path IS `cancelStep`'s rule

On a hit the worker **does not run that generation**. It:

1. remembers `traceBreakGen = generation`, so the breakpoint fires **once per generation**, and stashes
   `tracePendingBreak = { root, gen, nodeId }`;
2. `break`s the loop and lets the batch finish normally, posting the ordinary `stepped` **carrying
   `traceBreakPending: true`**;
3. then `flushTraceBreak()` **drops the queued reqId-less `step` messages** from
   `deferredDuringAsyncBatch` exactly as `cancelStep` does, and posts `traceBreak`.

⚠ **The Overseer's batches carry a `reqId`**, so they are never dropped (its runtime awaits that exact
id) — and the Overseer never traces anyway, Live excludes it.

⚠ **A breakpoint matches on `f` AND `v` records.** A breakpoint on a pure **value** node must fire even
though no flow record carries its id. ⚠ **Output-mapping records are deliberately NOT matched**: the
colour pass runs once per BATCH in production, so a pause *"before this generation"* cannot honestly be
attributed to it.

⚠ A generation that already broke is **traced again** (the panel keeps showing it) but does not break
again — `suppressBreak = generation === traceBreakGen` gates the break, not the trace.

⚠ **`traceBreakPending` rides the EARLIER message on purpose.** The play loop's rAF could fire between
the `stepped` and `traceBreak` tasks, and Resume then advanced **two** generations. The handler clears
`playingRef` synchronously on `stepped`; `cancelStep` stays as belt-and-braces.

⚠ **`traceBreakGen` is cleared at `setGeneration`** — the ONE seam that moves the counter,
`if (v <= generation) traceBreakGen = -1` — so no individual handler (Reset, `loadState`, `init`, an
Overseer preset load) can forget. The latch only means anything while the counter climbs; a leftover one
swallowed the first legitimate break at the new generation 0: *set a breakpoint, break at gen 0, reset,
play — and the run goes straight past the mark exactly once.*

### GPU freshness, residency, and the dropped neighbour table

⚠ **Every trace under GPU ownership is preceded by the existing one-shots** — `traceAwaitFreshness()`
calls `ensureCpuAttrsFresh()` when `gpuOwnsAttrs` and `ensureAgentStoreFresh()` when `agentStoreStale`.
**The runner never clears those flags**; it is a reader calling the engine's own readbacks, whose cost is
the documented W·H·D / population readback. This is the entire reason the sampled cadence exists: only a
breakpoint session pays a readback **per generation**.

⚠ `traceAwaitFreshness` returns **`null` — no promise, no microtask** — whenever neither one-shot is
needed. That is what lets the synchronous G/F-1 step path trace **in line** rather than deferring a
generation.

⚠ **The residency predicate gains a runtime term** — `agentResidentEligible()` returns false while
`traceEveryGen && traceArmed()`, **for either target kind**. The resident batch is ONE submit covering
many generations with a single readback per frame, so it structurally cannot host a per-generation hook:
for an *agent* target the CPU store is stale for all but the last generation of a slice, and for a *cell*
target the resident branch runs the grid's generations in a block AFTER the agent batch, so breaking
between them would leave the two layers at different generations. **Sampled tracing keeps residency** and
reads the store at the frame boundary; a breakpoint session drops to the per-generation path — slower,
correct.

⚠ **The WebGPU grid target drops its per-cell neighbour table** (`nbrTableDropped`) — the GPU computes
neighbours inline. `buildLoopArgs` then pushes `undefined`, which no *engine* path reads, but the trace
build of the STEP does, and it threw `Cannot read properties of undefined` on the first neighbour read of
every WebGPU model. Rebuilding the table is `total × nSz × 4` bytes — **2.8 GB at 300³**, the very thing
the drop exists to avoid.

So `computeCellNeighbours` was **extracted** from `buildNeighborIndices` — ONE definition of the torus
wrap, the constant-boundary sentinel and the 3D-layer maths (the full table is this function run over
every cell; 8 M entries byte-identical, 56.4 vs 56.1 ms) — and **`traceNbrRow(nbr, idx)` answers the
traced cell's row from it**. It returns a `Proxy` that is **array-LIKE, not an array**: a read inside the
traced row answers from the row, and **a read outside it answers the constant-boundary sentinel `total`**
— a defined boundary value rather than a crash. `traceRunner`'s duck-typed `isArrayLike` test is what
lets the sandbox wrap it as a shadow proxy like any other buffer, so writes to it are recorded and
discarded exactly as they would be for the real table.

⚠ It reaches the engine through an **optional trailing `traceNbrIdx` parameter** on `buildLoopArgs` /
`buildCellArgs` — the Rule Trace's **only** intrusion into the engine's arg builders. Absent (every
engine call site) the args are byte-identical to before.

### ⚠ The stale-codes rule

A `recompile` sets `traceCodesStale` — the fns are **held, not cleared**, and every hook goes quiet until
a `setTrace` carrying the rebuilt codes arrives. Which is why the main thread follows **every**
`recompile` post with a `setTrace`. Running a trace fn compiled from a graph the engine no longer runs is
*a lie with a plausible face*.

⚠ **The order is fixed by the engine's needs**: the recompile must not wait on a second full JS compile
of both graphs, so it always lands first and the trace build follows. `traceCodesStale` is cleared only
by `installTraceCodes` and by `clearTrace`.

### The `approximate` terms

`approximate` is a boolean; `approximateReason` is **exactly one term — the first that fired, in
"changes the answer most" order**. The worker is the only side that can know: two terms are read off the
emitted TEXT and one off the run's own state, none of which the main thread can see. A **term**, not a
sentence, because user-facing vocabulary stays on the main thread (D3) — and a term the panel does not
recognise degrades to the generic fallback rather than putting worker prose on screen.

| Term | Means |
|---|---|
| `asyncCells` | the cell's real turn comes after some neighbours have already written this generation |
| `asyncAgents` | agent attributes are single-buffered (the engine default) |
| `indicators` | the rule accumulates into an indicator every OTHER element also writes this generation |
| `agentField` | the agents deposit into a cell field AFTER the trace point |
| `staleAgentHash` | a spatial-hash query against a hash built for an earlier generation |
| `rng` | the sandbox draws from its own per-(element, generation) stream, so the draws differ from the real run's |

Three terms are **STATIC** — read off the emitted text once at install time (`usesRng` tests for the
inlined PCG step, `usesIndicatorWrite` for an `_indicators[…] =` / `+=` / `-=`, `usesAgentHash` for a
`_hashBinStart[` read) — and the rest are **DYNAMIC**, read off the run's own state. The order is per
side, and it is *how much this moves the answer*:

```
cell:   asyncCells → indicators → agentField → rng
agent:  asyncAgents → indicators → staleAgentHash → rng
```

*An out-of-order turn beats a shared accumulator beats a deposit that has not landed yet beats a stale
bin beats a different random draw.* `staleAgentHash` additionally requires `currentAgentHashGen !==
generation`; `agentField` requires the model's agents to actually deposit into a field, because the agent
step runs **before** the cell step.

## The main thread

### The store (`src/trace/traceState.ts`)

One module global in the `graphState.ts` shape — private `let`, getter, `subscribe` returning an
unsubscribe, equality-guarded setters that notify — because the consumers live in **three React trees**:
`SimulatorView`, `GraphEditor` / `CaNode`, the Trace panel, and `App`.

⚠ **TWO notification channels, and the reason is perf, not taste.** A trace arrives up to ~30×/s.
Per-TRACE state (the timeline, the newest entry) notifies `subscribeTraceTimeline`; per-SESSION state
(the target, the breakpoints, the pause, the selection, the cursor) notifies `subscribeTraceSession`. The
Live-bar chip subscribes to the SESSION channel and therefore **does not re-render per frame**.
`subscribeTrace` is both, for the one consumer — P4's imperative highlighter — that genuinely reacts to
each trace.

⚠ **The store is PURE STATE.** It posts no worker message and compiles nothing. `SimulatorView` owns the
worker and calls a setter here **in the same statement block** as its post — the mirror-invariant
discipline `overseerRunning` uses.

Other invariants it carries: the timeline is a ring of **40**; out-of-order replies are dropped by `seq`;
replies arriving after `clearTrace` never file into a targetless timeline; a user **pin** beats the
auto-followed newest rule trace **per graph kind**, so a grid+agents model does not flip the graph pane
between the two every frame.

### ⚠ Refs lead, and `setTrace` always carries the complete intent

`traceCellTargetRef` / `traceAgentTargetRef` lead the mirror state and the store (the `followAgentIdRef`
discipline — the draw loop, the worker message handler and `initWorkerWithDimensions` all read the target
outside React's render cycle, and a target set during a pointer gesture must be visible to the very next
frame). Three things must not drift:

1. **`setTrace.target` is the COMPLETE INTENT, never a delta** — always built from BOTH refs.
2. **Every arm that posts a `recompile` must post a `setTrace` with fresh `codes`**, because the worker
   marks its fns stale on every recompile. The `setTrace` goes **after** the recompile post, deliberately:
   the engine must never wait on a second full JS compile of both graphs.
3. **The trace build compiles from the SAME model object the engine's compile uses** — `dimsModelNow()`,
   extracted so the soft-recompile arm and the trace build cannot drift. It carries the LIVE dims a
   simulator resize / image import set without touching model state.

`buildTraceCodes()` is guarded like `safeCompileGraph` — a half-wired graph is a **supported** state in
Live and a throw out of here would unmount the app — and the agent compile receives the same stop-index
base the engine's does. It runs **only while a target exists** (it is a second JS compile of the graph),
and it is where `setTraceOrigin` publishes the origin tables to the store.

⚠ **No `requestTrace` is posted anywhere on the main thread.** `setTrace`'s own worker handler ends in
`scheduleTraceOfCurrentState()`, so the post that used to follow it simply ran a second identical trace of
every root and filed a second reply into the ring.

⚠ **The breakpoint set is subscribed into a REF, not `useSyncExternalStore`** — `SimulatorView` must not
re-render for it. On a change it posts `setTrace` **with no codes**, which is what makes a breakpoint or
cadence change free.

### The lifecycle

| Event | Cell target | Agent target | Breakpoints |
|---|---|---|---|
| **Soft recompile** (a node edit) | kept | kept | kept — and a `setTrace` with **fresh codes** follows the `recompile` post |
| **Structural rebuild** (`+attribute`, dimension change) | kept **iff still a cell of the new grid** (`idx < snapW*snapH*newD`, and the model still has a grid); otherwise dropped with a notice | ⚠ **always dropped** — *slot 7 of the new run is a different agent wearing the old one's number* | kept |
| **A fresh worker** (`initWorkerWithDimensions`) | re-posted **with codes** (a new worker has no trace fns at all), after `resetTraceSeq()` | same | kept |
| **Resize** (a simulator-panel resize, no model change) | **not dropped here** — it flows through `dimsModelNow()` into the soft-recompile arm; an out-of-range cell is caught by the worker's own guard → `traceTargetLost` | — | kept |
| **Model load / File › New** | cleared | cleared | ⚠ **cleared — the ONE place they are.** Ids are minted per model from the same `n4`, `n5`, `n6` sequence, so a leftover mark lands on whatever node of the NEW graph wears that id and pauses a run the user never marked. Everywhere else they deliberately survive |
| **Live exit** | session cleared | session cleared | **not** cleared — ⚠ a surviving target would be machinery the user can neither see nor stop, still paying for a trace build on every recompile. The inspectors keep their popovers; only the trace stops |
| **Resume** (`playing` goes true, by any path) | — | — | the pause readout is cleared |
| **`traceBreak`** | — | — | pauses through the **ordinary `playing` seam**; a resume clears the pause readout. ⚠ It also **puts the cursor on the node that matched** and the canvas follows it (see *Canvas focus*) |
| **`traceTargetLost`** | cleared by `kind` | cleared by `kind` | kept |

### The inspect subscription merge

The traced element joins the **state-reading terms** so its *current* values keep flowing after the
popover is closed. The **cell** target is merged into the existing `setInspectCells` post, so it costs no
extra message. The **agent** target goes into `agentStateIds` — ⚠ a **deliberately SECOND list**, not an
addition to `agentInspectIds`, because that list also drives the white inspect RINGS (2D and 3D) and the
traced agent has its own magenta mark: merging would draw both on one agent and blur the very distinction
the mark exists to make. The target therefore joins the **DATA terms only** — the ~3 Hz `getAgentState`
poll and the agent **UI-sync want-set** (`agent-render.md`): the trace re-evaluates its behaviour against
the CPU store every frame, so it is a state-reading feature exactly like an inspector.

### The marks

| Surface | How |
|---|---|
| 2D cell | a 2 px outline on the coloured highlight layer, **pixel-exact against the inspector hover-link's own geometry**. ⚠ Drawn **before the agents-only early return**, so a lattice-only model gets it, and **once per visible tile** under the infinity canvas — a mark that vanished on a tiled copy would read as *"the trace stopped"* |
| 2D agent | a **DASHED** ring, one step further out than the inspect ring. ⚠ Dashed because the solid rings are already spoken for: cyan hover, white inspect, amber follow |
| 3D cell | `gl3d.setTraceCell({ layer, row, col } \| null)` |
| 3D agent | `gl3d.setTraceAgent({ x, y, z, radius } \| null)` |

⚠ The two 3D entries are **separate slots**, deliberately: the inspect ring / cube paths stay
byte-untouched. Both are published **every frame, `null` included**.

The hue comes from `--color-trace` / `--color-trace-soft`, tokens in **both** themes (violet-shifted
under Nocturne's warm amber accent), defined **only** in `src/styles/tokens.css`. The 2D canvas reads the
token off the computed root style, cached per `data-theme`. ⚠ **Nothing hardcodes it** — except the 3D
renderer, which cannot read CSS at all; its two literals name the token in their comments, so a token
change has to be mirrored there by hand.

### The chip, and the keys

The Live bar carries `◉ Tracing cell (r, c)` / `Tracing agent #id` — through the **same
`formatCellCoords`** the Trace panel's header uses — with the pause readout (`tracePausedAt`) and an
**always-enabled ✕**. ⚠ The transient **lost notice is rendered OUTSIDE the chip's condition** (and
clears itself after 4 s): the case it exists for is precisely the case where the target is already gone,
so a notice nested inside `traceLabel &&` would never be seen at all.

The inspector chip is **`TraceChip`, defined once in `InspectCellPopover.tsx` and imported by
`InspectAgentPopover.tsx`** so the two can never drift. Its glyph is an inline SVG — three dots on a
stepped path — ⚠ deliberately **not** a filled circle, which reads as Follow's `◎` at 22 px.

`]` (step node) and `[` (back one node) are bound **ONCE, in `App.tsx`** (the `Ctrl+C/V/X`-was-bound-twice
lesson) and only in Live. They work **from either pane on purpose**: the cursor walks a recorded log, it
acts on no surface. Stand-down set, in order: any modifier · nothing traced · `isTypingTarget()` ·
`overlayOwnsKeyboard()` · `[data-capture-review]` (the capture-review modal, which carries no
`role="dialog"` of its own). ⚠ **Not** stood down for `<select>` — `]` / `[` have no native meaning in a
closed dropdown, exactly as `Enter` and `Ctrl+Enter` do not.

⚠ **`]` past the last node steps one generation and restarts the cursor on the next trace** — which is
why `simTransportState.ts` exists: `App` cannot reach `handleStep`, a closure inside an 18 kloc
component, and a second "post a step" implementation would be free to drift from the Overseer guard, the
`pendingStep` latch and the active-viewer argument. Every entry on `simTransportApi` is the transport
bar's own function, and `playing` is published from **one** point beside the state, not beside each of
the ten `setPlaying` call sites.

⚠ **`traceBreak` posts `cancelStep` immediately** rather than waiting for `useEffect([playing])` a commit
later — that is the mechanism Pause uses, and it also drops any reqId-less `step` still queued in the
worker. `stepped`'s `traceBreakPending` clears the `playingRef` **ref** (not the state), which is enough:
`sendNextStep` and the rAF `tick` both gate on it.

## The graph editor

### ⚠ The `data-trace` ATTRIBUTE contract

ONE `subscribeTrace` subscriber diffs three sets per trace and writes a `data-trace` attribute onto
`.react-flow__node` / `.react-flow__edge` by `data-id`.

⚠ **An attribute, not a class.** React Flow rebuilds the wrapper's `className` on every render and would
wipe an imperative class the moment a lit node was selected.

| Token | On | Means |
|---|---|---|
| `hit` | node | executed at or before the cursor — a node, or a **reroute dot** whose relayed value has a record |
| `hit current` | node | the cursor's flow node (written as that one string) — a 2 px ring plus a pulse |
| `dark` | node | exists in this scope and has **no** record in this trace |
| `flow` | edge | a taken flow wire **whose target has run** |
| `value` | edge | a value wire whose source port produced a record |

⚠ **`dark` is written but deliberately UNSTYLED.** *The trace adds light; it never greys the graph.* The
token exists as the DOM signal the verification asserts against. ⚠ The lit-wire rules need `!important`,
which is not laziness: `toRFEdges` puts the wire colour in an **inline `style`** on the path, and the
`:not(.selected)` guard keeps a deliberately selected wire red. ⚠ The selection ring stays **outermost**
over a lit node (the two rules are the same specificity, so without the paired `.selected[data-trace~=…]`
rules the glow would simply replace it), and the taken wire is a **pulse, not a marching dash** — the
legend already spends dashes on "not reached". `prefers-reduced-motion` turns both animations off.

Elements are found by `.react-flow__node[data-id="…"]` (CSS.escape'd) under the editor wrapper and
memoised in a map revalidated with `isConnected`, so a remount is caught. The DOM write **removes** the
attribute from everything no longer marked, then **sets it unconditionally on every current member** —
not just the diff's additions — because React Flow can remount an element (dropping the attribute)
without the set changing.

**The four inputs that re-light:** a new trace, a cursor move, a selection / origin-table change (all
three arrive on `subscribeTrace`), and the scope / graph kind the editor is showing (React deps). On
unmount every mark is removed — the editor unmounts on every Modeler ↔ Simulator tab switch.

### Cursor semantics

With **no cursor**, everything with a record in this scope is lit — the whole trace. With the cursor at
flow event *k*: every flow node that ran up to *k*, **plus the VALUE CONE of those nodes**. A value with
a record that nothing executed has consumed yet stays dark — ⚠ and that matters, because **the JS
compiler hoists values ABOVE the flow**, so nearly every value record precedes the first flow record in
the log; without the cone the first step would light the whole graph.

A flow node is `current` only when the cursor's event is itself an `f` record. ⚠ An `o` (branch-port)
record only counts **when `depth === scope.length`** — a record rolled up to a macro instance names an
INNER port, and a branch port means something only on the node that owns it.

⚠ **A taken branch whose body has not been reached yet stays dark.** That is what makes `]` walk the
chain one wire at a time rather than lighting the whole branch at once.

The `dark` pass skips reroutes, nodes with no `nodeType`, the macro **interface** nodes (`macroInput` /
`macroOutput`) and anything with no `getNodeDef` — comments and groups have no def, and the boundary
nodes emit no code.

### Reroutes, macro scopes, the mount race

- **Reroutes** are editor-only relays (`rerouteCollapse.ts` removes them before any compile), so a value
  recorded on `A:out` reaches `B` through two or more editor edges the compiler never saw. ⚠ Every edge
  is resolved **ONCE** to the real port it ultimately carries (`edgeOrigin`); "light every edge whose
  origin has a record" then lights the whole chain, dots included, **with no path walking per trace**.
- **Macro scopes** go through the two id spaces above: `buildMacroDefIndex` maps every macro INSTANCE to
  the DEF it instantiates (and is published to the store so `breakpointLoweredIds` resolves a def-scoped
  mark the same way), and `buildMacroOutputMap` maps a def id to which of the instance's OUTPUT ports
  carries which inner port. A macro instance's output wire therefore carries the inner `macroOutput`
  bridge source's record — ⚠ **one level deep** (`depth === scope.length + 1`); deeper resolves to no
  port key at all. ⚠ The editor's scope stack carries a leading `'root'` sentinel that names no def and
  is filtered out before any of this.
- ⚠ **The mount race.** Entering a macro is TWO passive effects in one flush: the highlighter (declared
  earlier, so it runs FIRST and already sees the new `currentScope`) and the scope effect that actually
  calls `setNodes`. The marks for the new scope were therefore computed correctly and written to elements
  **that did not exist yet** — and while the simulation is PAUSED no further trace ever arrives to write
  them again, so the inner path stayed dark until the user stepped. A **bounded rAF re-apply — a budget
  of 3, one in flight** — closes it, and covers a React Flow remount for free. Bounded so a genuinely
  absent id cannot spin.
- ⚠ The editor-trace index is keyed on **the edge array identity plus the node COUNT**, not the node
  array identity: a node drag replaces the node array 60×/s while changing neither the wiring nor which
  nodes are reroutes.

### Canvas focus follows the cursor

⚠ **A node the user is told to look at must be ON SCREEN.** Stepping `]` onto a node three screens away,
or breaking inside a macro that is not even open, showed the right node in the panel and an unchanged
canvas — the debugger's answer was invisible. So the store REQUESTS focus and **the editor performs it**:
it is the only side that knows what is mounted, where it sits and how far the viewport is from it.

The seam is a **third store channel** — `requestTraceFocus({ graphKind, nodeId, macroPath, reason })` /
`subscribeTraceFocus` / `takeTraceFocus()`. It carries an **event, not state**: `takeTraceFocus` returns
the request and clears it, so one request pans exactly once, and nothing about it is in the session
snapshot (which would re-render every breakpoint glyph for something none of them reads).

**Who asks, in ONE place each:**

| Trigger | Where | Reason |
|---|---|---|
| the cursor moves to a node (`]` / `[`, the panel's Back / Step node, a Steps-tab row click) | inside `setCursor` — every caller that hands over its `entry` gets it for free | `cursor` |
| `]` past the last node (steps a generation, restarts the cursor) | the `cursorRestartPending` arm of `pushTrace` | `step` |
| a **breakpoint hits** | `setPaused` — which now also **lands the cursor on the node** (the Help chapter always said it did), so the focus comes from the cursor trigger and is never doubled | `cursor`, or `break` when the mark has no flow record (a pure value node) |
| a **Breakpoints-tab row label** is clicked | `TracePanel` — `bp.macroPath` is already in DEF space, so no translation | `breakpoint` |

⚠ **Nothing asks per TRACE.** A playing model posts ~10 traces/s; a canvas that followed them would be
unusable. Measured: 74 generations, 40 ring entries, **zero** focus requests and an unchanged viewport.

**What the editor does with one** (`GraphEditor`, one `subscribeTraceFocus` subscriber):

1. **The sub-tab**, if the request names the other graph (`setActiveGraph` — the editor's own path).
2. **The scope.** `macroPath` is the **DEF** path, so it goes straight into `setCurrentScope(['root', …])`
   — the scope effect owns the node swap, the saved-viewport restore, `setOpenMacroScope` and the history
   reconcile. Set to the whole path at once rather than pushed level by level: the effect and the history
   reconciler are both written against the final array, and N intermediate renders would each swap the
   node set for a scope nobody sees. A root-scope request while inside a macro exits the same way.
3. **The centring.** ⚠ **A node already fully in view is NOT moved** (`nodeFullyInView`, 24 px margin) —
   stepping between two visible neighbours must not jitter the canvas. Otherwise
   `setCenter(cx, cy, { zoom: Math.max(currentZoom, 0.75), duration: 250 })`: the user's zoom is kept
   unless it is too far out to read a node, and **never zoomed out**. `prefers-reduced-motion` ⇒ duration 0.
4. **Mid-gesture the request is DROPPED** (`nodeDragActiveRef` / `isConnectingGlobal`) — a pan under a node
   being dragged or a wire being pulled would drop it. The cursor still moves; the next step pans.

⚠ **Why a bounded retry loop.** A scope or graph change re-mounts every node AND the scope effect restores
the viewport on a **50 ms timeout of its own**, so centring before that lands is overwritten a frame later.
A focus that changed the scope therefore waits out `TRACE_FOCUS_SETTLE_MS` (90) and then retries per frame
until React Flow has **measured** the node (P4's mount race wearing a different hat), bounded at 90 frames
so an id that is not in this graph cannot spin. Positions come from `getInternalNode().internals.positionAbsolute`,
never `node.position` — a node inside a GROUP is positioned relative to its parent.

The two decidable halves are pure and harnessed (§ L): `focusTargetForOrigin` (WHERE) and `nodeFullyInView`
(WHETHER). ⚠ `focusTargetForOrigin` is deliberately **not** `originInEditorScope`: that one answers *what
lights in the scope I am already in* and rolls a record up to the macro INSTANCE; focus answers *where do I
have to go*, so it keeps the record's own inner node and reports the whole DEF path to it.

### The tooltip

`onNodeMouseEnter` / `onEdgeMouseEnter` open a surface that is:

- **portalled to `document.body`** — a `position: fixed` element rendered from inside React Flow's
  transformed viewport is positioned against the TRANSFORM (the standing repo rule, `modeler-ui.md` Key
  Patterns);
- **`position: fixed`, `pointer-events: none`** — it can never eat a click meant for the canvas;
- ⚠ **carrying NO `role`.** `overlayOwnsKeyboard()` probes for `[role="dialog"] / [role="menu"]` and
  stands the global keys down while one is present. **A surface that opens on HOVER must never do that**
  (the viewer control paid for this lesson: an Enter swallowed just for mousing past).

It decodes every value by port type through the shared `formatTraceValue` — binary → true/false, a tag →
the option name, a neighbour index → `(dr, dc)` / `(dr, dc, dl)` through the dimension's codec, a
composite → `(x, y, z)` / `(r, g, b, a)` reassembled from the per-component records, an array →
`[a, b, …] (n)`. It shows the **cursor's latest record** when the cursor is set, `executed xN` plus the
taken branch for a flow node, `not reached in this trace` otherwise. It re-reads on each trace
(rAF-coalesced), and that re-render is **confined to the tooltip** — the graph itself is never
re-rendered by a trace. Its first frame renders `visibility: hidden` while it measures itself, then flips
to the quadrant that fits (the context menu's own discipline).

⚠ **Hover is offered only while a trace is on screen for this graph, and never during a drag or a
connection.** `onNodeDragStart` stands it down **before the group-only early return**, so it stands down
for EVERY node drag, not just a group's. The node lookup it uses is supplied by the caller, so the
tooltip never touches React Flow's store.

### The breakpoint glyph and menu item

A red dot **with a white ring** (decision A2 — readable on every header colour) in `CaNode`'s header,
hollow when disabled; rendered in **both** the collapsed and the expanded header.

⚠ It is driven by `useSyncExternalStore` on the **SESSION** channel with a **PRIMITIVE `0 | 1 | 2`
snapshot** (none / enabled / disabled). The snapshot function is called on *every* session notification —
a cursor step, a pause, a lost target — **once per mounted node**, so it has to compare equal for the
~300 nodes whose own mark did not move, or a keystroke would re-render the whole canvas. A trace never
re-renders a node at all (I5); only setting / clearing / disabling a mark does. The key's macro path is
the editor's open **DEF** path.

The node context menu gains `Breakpoint` / `✓ Breakpoint` under three conditions, all required: **Live is
shown**, the active graph is **not the Overseer**, and the node type can carry one. Comments, groups,
reroutes and the macro boundary nodes are excluded — they emit no code to stop at. Doctrine **hide**, not
grey: outside Live there is no running simulation for a breakpoint to pause and no graph pane beside it.

## The Trace panel

A **real flex sibling below the editor** under `.graphArea` in `ModelerView` (so the canvas shrinks and
React Flow re-fits), behind **two** conditions — `{live && <TracePanel />}` at the mount site, and
`if (!armed) return null` inside the component. Doctrine HIDE on both counts: outside Live the graph it
annotates is not on screen, and an idle Live session must pay no height.
Resizable by a top handle that mutates `style.height` during the drag, collapsible to a 24 px strip,
`{h, collapsed, tab}` persisted under its **own** key `genesisca_trace_panel` (`genesisca_sim_settings`
belongs to `SimulatorView`'s persist effect).

⚠ **`role="region"`, NEVER `role="dialog"` or `role="menu"`.** The panel is present for the *whole*
tracing session, so either role would silently disable `Enter`, `Space`, `]` and `[` for as long as the
user is debugging. `role="tablist"` on the tab strip is deliberately not one of the two probed roles.

⚠ **No button here keeps focus on a mouse press.** In Live `Enter` is the global play/pause and a focused
`<button>` also activates on `Enter` — a user who clicks Pause and then presses `Enter` would toggle play
**twice**. Every control is a `<TraceBtn>` whose `onMouseDown` preventDefault leaves focus where it was;
keyboard users still reach them by Tab, which is the case where one activation is correct.

⚠ It subscribes to the **timeline** channel, which fires on every trace — unavoidable, since showing
every trace is its job. The cost is controlled instead: the values rows and the steps list are memoised
per ENTRY ID, the cursor only re-renders a highlight class, the hidden tab is gated, step decoding is
lazy, chips are memoised, and the timeline auto-scroll is **write-only** (reading `scrollWidth` forced a
40-chip layout per trace).

**The transport row** is one Resume/Pause button driven by a published `playing` mirror on the widened
`simTransportApi`; `play` / `pause` / `stepGeneration` / `stopTrace` are the transport's and the chip's
**own handlers, never copies**. Back / Step node / Whole trace grey at the ends **with the reason**.
Also: the `⏸ paused at <node>` readout, the element label (`Cell (r, c)` / `Cell (layer, r, c)` /
`Agent #id`, through the one shared `formatCellCoords`), the `approximate` badge with its specific
reason, the `truncated` badge, and ✕.

**The timeline strip** is one chip per ring entry — `gen N · Step / Output Mapping (name) / Brush (name) /
Behaviour / Division / Reset · Init …` — horizontal scroll only, never wrap (A3). The newest is followed
unless the user **pinned** an older chip; `↧ follow newest` appears only while the pin is still live in
the ring. The strip is filtered to the graph kind the editor is showing.

**The three tabs.**

- **Values** — every attribute in declaration order (A6: never re-sorted), `current → next` where CURRENT
  is the reply's `snapshot` and NEXT is the own-element write; changed rows accented. Then orientation /
  colour swatch / glyph / neighbour writes decoded to `(dr, dc[, dl])` / indicator writes / stop /
  skipped for cells, and position / velocity / radius / `Force applied (fx, fy)` **as the delta** /
  requests (`Divide · queued, not applied`) / bond lanes / field deposits / sprite for agents.
  ⚠ **NOTHING THE TRACE WROTE MAY BE INVISIBLE.** Every write is claimed by exactly one row builder and
  whatever is left over comes out as a generic `param[index] prev → value` row. The `claimed` set is the
  enforcement and the harness asserts it — a write that silently vanished would make the panel quietly
  lie about what the rule did, the one thing a debugger must never do.
  ⚠ **The bond request lanes MIRROR AN EMITTER**: the verbs are encoded across the signs of two lanes by
  `bondRequestEmitJS.ts` (and its WASM / WebGPU mirrors), and `decodeBondRequest` imports its constants
  from `bondRequestQueue.ts` rather than re-spelling them.
- **Steps** — the flow events in order with the taken port, `(in <macro>)` for records inside a closed
  macro, click = cursor (and the canvas follows it), lazily-decoded value expanders, `⚑ request` rows.
- **Breakpoints** — enable / remove / Clear all, **def-scoped labels**, an empty-state hint. The
  label is a button: clicking it **shows that node on the canvas** (entering its macro scope when the
  mark lives inside a def) without touching the cursor — the checkbox and the ✕ keep their own jobs,
  and no control here takes focus on a mouse press.

The numbers-to-sentences logic lives in the DOM-free `traceValues.ts`, driven by harness § J, so the
panel renders what it returns and decides nothing about what a write MEANS. `formatNumber` / `formatNI`
are shared with the tooltip so the two surfaces cannot print a value differently.

## UI doctrine — every control

Per `CLAUDE.md`'s *an enabled control must do something*: structurally impossible ⇒ **hide**; temporarily
unavailable ⇒ **grey with the reason**.

| Control | Disposition | Why |
|---|---|---|
| The **Trace** chip on the cell / agent inspector | **HIDE** outside Live, and on transient (sweep) popovers | the graph is not on screen; a transient inspector is about to be discarded (the Follow precedent) |
| The **Trace panel** | **HIDE** outside Live and with no target | an empty drawer would steal height from the graph |
| The node context menu's **Breakpoint** item | **HIDE** outside Live; excluded on comments / groups / reroutes / macro boundary nodes | the trace cannot run there, and those nodes emit nothing |
| **Resume / Pause**, **Step generation**, **✕** | **ENABLED** always | the transport's own handlers; ✕ must work even while the lost notice is up |
| **Back one node** / **Step node** | **GREY with the reason** at the ends of the trace | one press away from being available again |
| **Whole trace** | **GREY with the reason** when the cursor is already `null` | same |
| The Live-bar **chip** | shown only while a target exists — but the **lost notice renders outside that condition** | the target is gone precisely when the reason matters |
| The `approximate` / `truncated` badges | shown only when true, with the specific reason in the tooltip | a badge that is always there says nothing |

## What the trace cannot promise

Stated up front in the UI (the `approximate` badge), in Help, and here.

| Case | Behaviour | Why |
|---|---|---|
| **Random draws** | the trace's values are **its own**, from a stream seeded per (element, generation) — so re-tracing is stable — and are **not** the draws the engine made | on JS/WASM the shared stream's state at this element depends on every earlier element's draws this generation; on WebGPU the per-cell PCG state lives on the GPU |
| **Asynchronous update mode** | the trace evaluates against the **start-of-generation** state; the engine may have updated neighbours earlier in the same order. `approximateReason: asyncCells` / `asyncAgents` | single-buffer async semantics are order-dependent by design |
| **f32 on WebGPU** | the trace is f64; values can differ in the last bits | a documented intentional difference of the WebGPU target |
| **Indicator accumulation** | the trace's indicator write is this element's contribution, not the generation's total. `approximateReason: indicators` | every other element writes the same accumulator this generation |
| **A cell field the agents deposit into** | the trace reads it before the deposit. `approximateReason: agentField` | the deposit happens after the trace point |
| **The agent spatial hash** | may be one generation old at the trace point. `approximateReason: staleAgentHash` | the agents have moved since they were binned |
| **Everything else** (sync, non-random) | the trace's "next values" **ARE** what the engine writes — the JS reference is bit-identical to WASM. The panel shows the previous trace's prediction against the now-current values as a visible check | |

## Verification recipe

```bash
node scripts/test-rule-trace.mjs                            # the feature harness, § A–K
node scripts/check-compile-identity.mjs --compare <base>    # I1 + the six trace surfaces
node scripts/parity-agent-wasm.mjs
node scripts/verify-agent-render.mjs
node scripts/verify-sparse-stepping.mjs
npx tsc -p tsconfig.app.json --noEmit && npm run build
```

`scripts/test-rule-trace.mjs` drives the **shipped** modules (every DOM-free module in this feature
exists in that shape for exactly this reason) and every claim is negative-controlled:

| § | Holds |
|---|---|
| A | **Coverage** — every library model, every recorded id resolves through the origin table (I6) |
| B | **Values** — a traced cell's own-cell writes equal the real step, on shipped models |
| C | **Flow** — the recorded branch is the one the data selects |
| D | **Isolation** — the sandbox is a reader; buffers hash-identical around a batch of traces (I2) |
| E | **Agents** — a traced agent records the force the real behaviour writes |
| F | **The runner** — the event cap, the escape, error capture, the private RNG, shadow reads |
| G | **Negative controls** — each injected fault must FAIL a *named* check |
| H | **Scope mapping** — `originInScope` |
| I | **The editor graph maths** — edge / reroute origins, value cones, `originInEditorScope` |
| J | **Values (P5)** — raw writes back into the sentences the panel shows, and nothing left unclaimed |
| K | **The P7b findings** — the write-side name, the root record, the sandbox method policy |
| L | **Canvas focus (P8)** — where to go (`focusTargetForOrigin`, in DEF space, inner node not instance) and whether to move at all (`nodeFullyInView`) |

⚠ **A new emitted surface MUST be added to `check-compile-identity.mjs`** — the six trace surfaces are on
that list, so an emit change to the trace build is caught the same way an engine emit change is.

**Live, in the real UI** (0 console errors is part of the claim): a 2D cell model on **WebGPU and on
WASM** (Game of Life), a 3D cell model (Life3D — the 3D NI codec and `(layer, r, c)`), a 2D agent model
(Particle Life — residency under sampled tracing, and leaving it under a breakpoint), a grid+agents model
(Chemotaxis — both targets, the E2 composite), an async model (Snake — the aliased `r === w` write), a
macro model (Kelp War — instances at root and the inner path inside), a division model (Morphogenesis).

**The DEV hooks** every measurement was taken with:

| Hook | Answers |
|---|---|
| `window.__traceState()` | the store's session + timeline snapshot |
| `window.__traceStore` | the store's setters, for driving it from the console |
| `window.__traceMarks()` | which node / edge ids currently carry which `data-trace` tokens |
| `window.__traceView()` | the tooltip view the highlighter publishes |
| `window.__tracePerf(reset?)` | the highlighter's own mean / max cost |
| `window.__tracePanelPerf()` | the Trace panel's body render cost |
| `window.__traceFocus()` | the last canvas-focus request the editor performed, and whether it MOVED the viewport |

## Known limitations and follow-ups

None of these is a defect; each is a deliberate boundary. The register with its reasoning is
[`../HANDOFF_RULE_TRACE.md`](../HANDOFF_RULE_TRACE.md) § 4.

- ⚠ **A breakpoint set inside a macro arms in EVERY instance of that def.** The editor's scope stack
  names defs, not instances, so a def-scoped mark is the only thing it can express. The honest reading of
  a def-scoped editor — but it surprises anyone who set the mark while looking at one instance.
- **Macro output bridging is one level deep**: a macro instance's output wire carries the inner
  `macroOutput` bridge source's record; a chain of bridges deeper than one is not walked.
- **The agent hash used by a trace is the previous generation's** at the trace point — surfaced as
  `approximateReason: 'staleAgentHash'` rather than papered over with a rebuild the trace would pay for.
- **Out of scope** (brainstorm § 5): conditional breakpoints, breakpoints on value nodes, data
  breakpoints; editing a value mid-trace and re-running from the cursor; tracing several elements at
  once; recording a trace history to a file; the Overseer graph (Live already excludes it).
- **Values painted permanently on wires** is a v2 candidate (decision D9) — a 300-node graph with
  always-on wire labels is unreadable, so values are on hover.
- **The inspector popover header omits the layer in 3D** where the trace surfaces include it
  (`(layer L, r, c)`). A pre-existing asymmetry, left alone rather than changed under a trace commit.
- `requestTrace` has **no sender** — kept as the seam a "re-trace now" gesture needs. See the protocol
  table's warning before adding one.

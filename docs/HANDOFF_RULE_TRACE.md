# Handoff — **Rule Trace** (trace one cell's / one agent's rule through the graph, live)

> **Status: delivered.** Branch `debug-mode`, base `8c7f6d4`. Eight commits, P0 → P7b.
> Design authority: [IMPACT_MAP_RULE_TRACE.md](IMPACT_MAP_RULE_TRACE.md) (traps by number) ·
> origin [BRAINSTORM_RULE_TRACE.md](BRAINSTORM_RULE_TRACE.md) (decisions D1–D10) ·
> [PLAN_RULE_TRACE.md](PLAN_RULE_TRACE.md) + [`.html`](PLAN_RULE_TRACE.html) (the phase map, the
> invariants I1–I8, the P0 presentation decisions A1–A7).
>
> **The reference doc is [`areas/rule-trace.md`](areas/rule-trace.md)** — what is true and what will
> bite you. THIS file is the narrative: what each phase delivered, the numbers that were measured, the
> adversarial review's findings, where the build deviated from the plan, and what is left.

---

## 1. The one architectural claim, restated

The chosen cell / agent's rule is **re-evaluated** each generation by a **trace build** of the JS
reference compile — the same graph, the same lowering passes, the same node emitters, plus per-node
value records, per-flow-node execution records and a single-element body — run in the worker against
the live state inside a **write-recording sandbox**. The engines (JS / WASM / WebGPU, 2D / 3D, cells /
agents) are **not instrumented and not changed**.

That is what makes the feature **ALL-TARGET by construction** rather than by effort: nothing in the
trace path knows which engine is running the model, so there is no target to "port it to later" and no
clamp to add. It is the same standing as the Grid Init Event and the Agent Init Event, which are
JS-on-CPU on every target.

---

## 2. The phases, and what each one delivered

| Phase | Commit | Delivered |
|---|---|---|
| P0 | `fdca9ab` | The illustrated plan `PLAN_RULE_TRACE.html` (11 sections, self-contained inline CSS + SVG) and the seven presentation decisions A1–A7 it surfaced. |
| P1 | `967039f` | The compiler's `opts.trace` build, the origin table, the sandbox (`traceRunner.ts`), the value harness. |
| P2 | `37770c1` | The worker half: root registry, wire protocol, the three cadences, breakpoints, GPU freshness, the residency term. |
| P3 | `7fd7ecd` | The main-thread half: the trace store, the inspector Trace chips, the Live-bar chip, the canvas marks (2D + 3D, cells + agents), the lifecycle, the keys. |
| P4 | `e94af27` | The lit path in the graph editor: the imperative highlighter, the cursor, the breakpoint glyph + menu item, the hover tooltips, macro scopes. |
| P5 | `b1902f2` | The Trace panel: transport, timeline, Values / Steps / Breakpoints. |
| P6 | *(this one)* | The documentation sweep. |
| P7a/b | `2e7e760` | The adversarial review and the fix session that closed its twelve findings. |

### P1 — the trace build, the origin table, the sandbox (`967039f`)

`compileGraph` / `compileAgentGraph` gained an additive `opts.trace`. Every value node appends one
`_tr.v(id, port, value)` per declared value-output port, resolved through the same `varName` consumers
read and the same dynamic port builders the canvas uses (extra slots, census, bond-attr ports, input
parameters), `typeof`-guarded for ports a config never declares and **appended to the node's own code**
so no TDZ `const` is ever referenced. Every flow node emits `_tr.f(id)` before its code and
`_tr.o(id, port)` at every branch body it opens and before its `next`.

The per-element loops became a **single-element body** for step / init / output mapping / agent
behaviour / agent OM, while `inputColor` / division / agent IM keep their element parameter and the
global roots take `_tr` only. The sparse dual loop, the linked-indicator embedding and the
`_rngState` write-back are dropped; accessor-CSE and aggregate fusion are OFF so every node
materialises a record; **every other pass runs unchanged**.

The result carries `trace.paramNames` (the full signature per root key) and `trace.origin` (lowered id
→ user node / port / composite component / macro path), folded from **additive `origin` maps on 11
lowering passes with NO id renamed** — a rename would move emitted bytes and can flip CSE's canonical
pick.

**Measured / proved.** The NORMAL build is byte-identical: **31 models, all surfaces unchanged** vs the
`8c7f6d4` baseline. The new harness `scripts/test-rule-trace.mjs` resolved **2 059 records across 31
models** through the origin table; traced own-cell writes equalled the real step on Game of Life,
Extended Wireworld, Gray-Scott, Life3D and a multi-attr synthetic; buffers stayed hash-identical around
100+ traces; Boids and a synthetic agent model recorded exactly the force / attribute the real
behaviour writes; 15 runner checks; **3 negative controls detected**.

⚠ **One finding the harness caught during P1 itself:** dropping the bulk `w.set(r)` copy outright
traced `updateAttribute`'s read-modify-write **wrong** (on Extended Wireworld). The fix is the
**single-cell copy** — see the deviations table below.

### P2 — the worker (`37770c1`)

New DOM-free `traceProtocol.ts`; the worker evals every trace root into a registry keyed by the
compiler's own root keys and runs each through the sandbox against the LIVE buffers **via the engine's
own arg builders** plus the trailing trace args, so the ABI-mirror discipline is inherited rather than
duplicated. The three cadences landed (sampled at batch end, every-generation with the breakpoint test,
on-demand coalesced through a microtask), the event roots were wired, and `traceTargetLost` /
`traceCompileErrors` were added.

The WebGPU grid target drops its per-cell neighbour table, so `computeCellNeighbours` was **extracted**
from `buildNeighborIndices` (ONE definition of the torus / sentinel / 3D-layer math) and `traceNbrRow`
answers the traced cell's row from it, instead of rebuilding a table the drop exists to avoid.

**Measured.** Traced own-cell writes vs the real next generation: **0 mismatches over 198 cells** (Game
of Life WebGPU 90, Game of Life WASM 60, Life3D 48). **76 traces / 76 stepped at an unchanged 25
gens/s.** A breakpoint at G/F 50 stops the counter with the board hash unchanged, drops the queued
batch, resumes one generation and re-breaks at the next. 50 traces leave the attribute hash identical on
WASM and WebGPU. The neighbour-maths extraction: **8 M entries byte-identical, 56.4 vs 56.1 ms.**

⚠ **The runner fix the review surfaced here:** an ALIASED buffer (async `r === w`, async agent attrs)
now gets ONE shadow **by identity**, so a self-read after a self-write sees the write — two shadows had
de-aliased the Snake's turn. `sharedProxies:false` exists only for the WebGPU sync grid, whose separate
write buffer was dropped for memory.

### P3 — the main thread (`7fd7ecd`)

`src/trace/traceState.ts` (the store, two notification channels), `src/trace/traceOrigin.ts`
(`originInScope` — the ONE prefix rule), `simTransportState.ts` (the seam `App` needs to reach the
transport's own Step). `SimulatorView` gained the target refs (refs lead the mirror state and the
store), the complete-intent `setTrace`, the lifecycle across every arm of the model effect, the
inspector Trace chips, the Live-bar chip, and the marks on all four surfaces (2D cell outline, 2D agent
ring, `gl3d.setTraceCell`, `gl3d.setTraceAgent` — separate slots, so the inspect ring / cube paths are
byte-untouched). `--color-trace` / `--color-trace-soft` landed in BOTH themes; nothing hardcodes the hue.

**Measured.** Cost **27.0 → 25.8 gens/s (−4.4 %)** with `pushTrace` mean **0.011 ms** and **63 React
commits with tracing vs 63 without**. The 2D outline bbox 531–534 × 444–447 against the inspector
hover-link's own geometry 531.33 / 444.81 / 2.657 — pixel-exact. Life3D: 519 magenta GL px → 0 on stop.
An inline edit costs exactly 1 recompile + 1 `setTrace`; a `+attribute` rebuild keeps the target and
re-posts once; a 300→100 resize drops it; File › New clears everything.

### P4 — the lit path (`e94af27`)

ONE imperative highlighter: a single `subscribeTrace` subscriber diffs three sets per trace and writes a
`data-trace` **attribute** onto `.react-flow__node` / `.react-flow__edge` by `data-id`. New DOM-free
`traceGraphMap.ts` (edge origins, reroute origins, value cones, macro def index, macro output map, root
id) driven by harness § I (21 checks + 2 negative controls). Hover tooltips portalled to `document.body`,
`position: fixed`, `pointer-events: none`, **no role**. The breakpoint glyph in `CaNode` via
`useSyncExternalStore` on the SESSION channel with a **primitive snapshot**, so a cursor step re-renders
no node.

**Measured** on a 300-node graph at ~44 traces/s: highlighter mean **0.571 ms / max 1.70 ms**; React
commits per generation **1.018 with tracing vs 1.017 without** (zero caused by the highlighter);
throughput **−7.5 %** (the worker's own trace evaluation, not the editor). Game of Life: 5 hit / 7 dark,
exactly the origin-resolved set, the untaken branch dark.

### P5 — the Trace panel (`b1902f2`)

A real flex sibling below the editor (the canvas shrinks and React Flow re-fits), mounted only in Live
and only while a target exists, `role="region"`, no button keeping focus on a mouse press, `{h,
collapsed, tab}` persisted under `genesisca_trace_panel`. The transport row is driven by a published
`playing` mirror on the widened `simTransportApi` — `play` / `pause` / `stepGeneration` / `stopTrace`
are the transport's and the chip's own handlers, never copies. The decoding lives in the DOM-free
`traceValues.ts`, driven by harness **§ J: 51 checks + 3 negative controls**, including a 3D neighbour
write on a 4³ grid negative-controlled against a wrap-blind offset.

**Measured.** Editor 964 → 583 px + a 220 px panel; **19 paused steps with the previous NEXT == the new
CURRENT on every one**; 10/10 single-generation steps; cursor `n9 → n6 → null` with `data-trace~="current"`
following; a Get Cell Attribute mark pauses at gen 57; Particle Life agent #984 `Force applied → (0.0275,
0.0163)`; pinning held through gens 54 → 56; resize 220 → 301, collapse 24, persistence across Modeler ↔
Live; `activeElement` BODY after a click, **0 dialog/menu roles**. Panel body render **0.01 ms mean /
0.10 ms max over 340 Particle Life traces** — down from **7.5 ms** before gating the hidden tab, lazy
step decoding, memoised chips and the write-only scroll.

⚠ Reading `scrollWidth` on the timeline strip forced a 40-chip layout **per trace**; the auto-scroll is
therefore **write-only**.

### P7a/b — the adversarial review and the fixes (`2e7e760`)

A read-only session reviewed the whole diff against I1–I8 and the impact map's traps. Twelve findings
were confirmed and closed in one fix commit.

| # | The finding | The fix |
|---|---|---|
| F1 | An ALIASED buffer's shadow was named after the FIRST parameter that reached it, and every ABI lists `r_<id>` before `w_<id>` — so under async cells, async agent attributes (the default) and **every** division trace, the own-element write was filed under `r_…`: the Values tab said "unchanged" while printing the real answer as an unnamed "engine write" (Snake `Type Head → Head` when the rule sets Body; Ant `carrying false → false`). | The **write-side name wins** the entry; neighbour-orientation writes gained their row builder. Harness § K drives the real Snake / Amphiphile trace fns with `r === w`. The reviewer's library sweep: **19/19 models with zero unknown rows**. |
| F2 | A breakpoint on any ROOT node could never fire — no `f` record ever named the root (its body IS the wrapper) — while it still forced the every-generation cadence and its GPU readback. | `compileRoot` emits `_tr.f(root)` + a wired-guarded `_tr.o(root, port)` once, ahead of the flow chain: **the root is flow event 0 of every trace**. A breakpoint on Generation Step now pauses on GoL/WebGPU and Snake/WASM. |
| F3 | A stale `traceBreakGen` survived Reset / `loadState` and swallowed exactly one legitimate break at the same generation number. | Cleared at the ONE seam that moves the counter — `setGeneration`, on any non-monotonic move — so no handler can forget. |
| F4 | The shadow proxy was **allow-by-default for methods**: `.push` / `.splice` wrote straight through to the engine buffer (measured `[1,2,3,4]` → `[1,2,3,4,99]`). | **DENY by default.** Every function-valued property other than the deliberate no-ops throws `TraceSandboxEscape` on call. No read-only allow-list — a method bound to the base would read around the shadow. |
| F6 | The approximation TERM was not on the wire, so the panel guessed the sentence from the MODEL and fell back to a circular "see the badge for why". | `approximateReason` travels on the reply (`asyncCells` / `asyncAgents` / `indicators` / `agentField` / `staleAgentHash` / `rng`, first-fired by weight). Extended Wireworld now reads *"the rule accumulates an indicator other cells also write this generation"*. |
| F7 | Resume occasionally advanced **two** generations — the play loop's rAF fired between the `stepped` and `traceBreak` tasks. | The news rides the EARLIER message (`traceBreakPending` on `stepped`; the handler clears `playingRef` synchronously), with `cancelStep` as belt-and-braces. **40/40 resumes advance exactly one generation** on GoL/WebGPU at G/F 148. |
| F8 | Perf accumulators ran in production. | DEV-gated. |
| F9 | Root keys were spelled by hand in three places; a key built under one spelling and filtered under another fails **silently** (the periodic root simply never pairs with its code). | ONE definition in `compiler/traceOrigin.ts`, re-exported by the protocol, used by all 12 compiler sites. Dead umbrella unions removed. |
| F10 | The Steps row carried a phantom `role="button"`. | Dropped. |
| F11 | Two spellings of the cell coordinates. | One `formatCellCoords` for the chip and the panel header (`(layer L, r, c)` in 3D). |
| F12 | Setting a target double-traced every root (the redundant `requestTrace` after a `setTrace` whose handler already schedules one). | The redundant post is gone: **2 replies per target, was 4.** `requestTraceMsg` is kept as the seam a future "re-trace now" gesture needs. |
| F13 | The SAMPLED cadence ran at the frame rate. | Throttled to **10 Hz with a trailing edge** (`TRACE_SAMPLE_MIN_MS = 100`; every-gen and on-demand untouched). Measured **Life3D 24³ at max rate: −12.0 % with the throttle vs −20.2 % without.** |

P7b also **corrected two comments the review found inaccurate**. The normal emit stayed byte-identical
on every pre-existing surface (31 models); the **trace** surfaces moved only by F2, and a new identity
baseline was captured for them.

---

## 3. Deviations from the plan (as built)

These are also recorded as an *As built* section in `PLAN_RULE_TRACE.md`.

| # | The plan said | What shipped, and why |
|---|---|---|
| 1 | Drop `bulkCopyLines` entirely. | **The single-cell copy.** Dropping it outright traced `updateAttribute`'s read-modify-write wrong — caught by the harness on Extended Wireworld. The trace copies the traced cell's row only. |
| 2 | The root wrapper emits records for its own value-outs. | **The root is flow event 0** (`_tr.f(root)` + a wired-guarded `_tr.o(root, port)` ahead of the flow chain). Forced by F2 — without an `f` record for the root, a breakpoint on it could never fire. P4's editor-side synthesis of the root became an idempotent fallback. |
| 3 | Toggle CSS **classes** (`traceHit` / `traceCurrent` / …) on `.react-flow__node[data-id]`. | A **`data-trace` attribute** with a token list. React Flow rebuilds the wrapper's `className` on every render and would wipe an imperative class the moment a lit node was selected. |
| 4 | Breakpoints keyed by `macroPath + innerId`, "so the same macro instanced twice can carry different breakpoints". | **Def-scoped.** The editor's scope stack names macro **DEFs**, not instances (entering a macro edits the shared definition), so a breakpoint inside a def is the only thing the editor can express — and it **arms in every instance**. Documented as a known limitation. |
| 5 | The Live-bar chip gets `traceLabel` / `onStopTrace`. | Plus **`tracePausedAt`**: the pause readout is part of the chip's contract, not a separate surface, so the reason is visible from the pane the user is looking at. |
| 6 | `setTrace { target }`. | **Complete intent, never a delta** — one target sets that kind and clears the other, an array sets both, `null` clears both. A single delta field is ambiguous the moment a grid+agents model wants to drop only one of its two targets. |
| 7 | `traceTargetLost { reason }`. | **`traceTargetLost { kind, reason }`** — `'cell' \| 'agent' \| 'both'`. The main thread was sniffing the kind out of the prose. |
| 8 | The Values tab lists attributes and engine writes. | The **Output Mapping** entry also gets a **colour row** (`colors` at `idx*4`, decoded to a hex swatch), so the OM trace shows what it actually produced. |
| 9 | Sampled = one trace per root **per batch**. | Plus the **10 Hz throttle with a trailing edge** (F13). A batch at a high frame rate is not a useful sampling unit. |
| 10 | One shadow proxy per argument. | **Identity-aliased proxies** (`sharedProxies`, default true): the same array under two parameter names gets ONE shadow, matching the engine's single-buffer semantics where it aliases. `false` only for the WebGPU sync grid, whose separate write buffer was dropped for memory. |

---

## 4. Follow-ups register

Nothing here is a defect; each is a deliberate boundary.

| # | Item | Note |
|---|---|---|
| 1 | **Def-scoped breakpoints arm every instance.** | The honest reading of a def-scoped editor. An instance-scoped mark needs the editor to gain an instance-scoped scope stack first. |
| 2 | **Macro output bridging is one level deep.** | A macro instance's output wire carries the inner `macroOutput` bridge source's record. A chain of bridges deeper than one is not walked. |
| 3 | **The agent spatial hash may be one generation old at the trace point.** | Surfaced honestly as `approximateReason: 'staleAgentHash'` rather than papered over with a rebuild the trace would pay for. |
| 4 | **Conditional / data breakpoints, breakpoints on value nodes.** | Out of scope (brainstorm § 5). |
| 5 | **Values painted permanently on wires (a toggle).** | v2 candidate (decision D9). |
| 6 | **The inspector popover header omits the layer in 3D** where the trace surfaces include it. | Pre-existing asymmetry, left alone rather than changed under a trace commit. |
| 7 | Editing a value mid-trace and re-running from the cursor; tracing several elements at once; recording a trace history to a file; the Overseer graph. | Out of scope (brainstorm § 5). |
| 8 | `requestTrace` has **no sender**. | Kept deliberately as the seam a "re-trace now" gesture needs; a future sender must check whether the state-changing message it follows already schedules a trace (F12). |

---

## 5. Verification recipe

The reference doc carries the full recipe; in short:

```bash
node scripts/test-rule-trace.mjs                        # § A–K, value-level, negative-controlled
node scripts/check-compile-identity.mjs --compare <b>   # the normal surfaces + the six trace surfaces
node scripts/parity-agent-wasm.mjs
node scripts/verify-agent-render.mjs
node scripts/verify-sparse-stepping.mjs
npx tsc -p tsconfig.app.json --noEmit && npm run build
```

Live, in the real UI: a 2D cell model (Game of Life on WebGPU **and** on WASM), a 3D cell model
(Life3D), a 2D agent model (Particle Life), a grid+agents model (Chemotaxis), an async model (Snake), a
macro model (Kelp War), a division model (Morphogenesis). The DEV hooks
`window.__traceState` / `__traceStore` / `__traceMarks` / `__traceView` / `__tracePerf` /
`__tracePanelPerf` are how every number above was taken.

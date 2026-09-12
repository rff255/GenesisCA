# Brainstorm — **Rule Trace** (the "live debug" of a cell's / an agent's rule)

> **Status: design document, 2026-09-12.** Companion of [IMPACT_MAP_RULE_TRACE.md](IMPACT_MAP_RULE_TRACE.md)
> and [PLAN_RULE_TRACE.md](PLAN_RULE_TRACE.md) (+ `.html` mockup). Branch `debug-mode`.
>
> The request: with **Live** mode shipped (graph + running simulation side by side), add the feature
> "loosely considered since the early versions": pick ONE cell / ONE agent and **watch its rule execute
> in the graph** — nodes and wires light up along the executed path, the values on the wires are
> visible, the next-generation values are listed, the other events (init, brush, periodic, output
> mapping…) show up when they fire, and because a generation runs far faster than a human can follow,
> there are **breakpoints, resume, and step-one-node**.

---

## 1. What comparable tools do

| Tool | The mechanism | What we take |
|---|---|---|
| **Unreal Blueprints** (debugger) | Pick a *debug object* (one actor instance) from a dropdown; the exec wires **pulse** along the path taken; hovering a data pin shows the last value; **breakpoints** on nodes (red circle), *Resume / Frame skip / Step into / over / out*; a **Watch** list; a per-graph *call stack*. | The whole shape: a chosen instance, pulse-along-the-path, hover values, node breakpoints, node-stepping. |
| **LabVIEW** (*Highlight Execution* — the light bulb) | Animates data flowing along wires **in slow motion**, probes on wires show values, breakpoints on wires/nodes, single-step. The closest analogue to a dataflow CA rule. | "Show the flow slowly" = our per-node stepping cursor; probes = hover tooltips. |
| **Blender** (geometry / shader nodes) | After an evaluation, sockets carry an *inspection* value: hover a socket → the last value (and a timing overlay per node). No stepping — the tree is pure. | Hover = last evaluated value, always available after any evaluation. |
| **Grasshopper** (Rhino) | Hover a parameter → data tree tooltip; components turn orange/red with runtime messages; no stepping. | Per-node status colouring (executed / not reached / errored). |
| **Unity Visual Scripting** | In play mode the executed flow highlights; port values print on the wires. | Values *on* the wire as an optional overlay (v2 here). |
| **Scratch** | The running script gets a yellow glow; *turbo mode* / single-step were removed — too fast to follow. | The cursor concept is what makes "too fast" tolerable. |
| **Excel** *Evaluate Formula* | Step through one formula's sub-expressions, seeing each intermediate. | Stepping through a **value** chain, not just flow. |
| **NetLogo** | *Agent monitors* (an inspector per turtle) — no graph, but the "watch one agent" idiom is the one users already know from us (the inspector + Follow). | The inspector is the entry point. |

**Nothing we compared re-runs a rule in an instrumented interpreter while the production engine keeps
running.** Unreal instruments the same VM it runs on. We *cannot*: the production engines are WASM and
WGSL, and an instrumented WASM/WGSL is out of the question (per-node value capture inside a 25 M-cell
shader is the opposite of what the engines exist for). So the central design decision is:

> **The trace is a re-evaluation.** For the chosen element, the JS *reference* compile of the rule
> (bit-identical to WASM by contract) is re-emitted in a **trace mode** — single-element body,
> per-node value records, flow records — and run in the worker **against the current state, inside a
> sandbox that records writes instead of applying them**. The engine is untouched; the trace is a
> side computation that costs one cell's worth of work per trace.

This satisfies **ALL-TARGET DELIVERY** by construction: the trace runs identically whether the model
executes on JS, WASM or WebGPU, 2D or 3D, cells or agents. It is not a "JS-only feature"; it is a
feature *about* the rule that happens to use the JS reference emitter as its instrument — exactly the
way the Grid Init Event / Agent Init Event / division are JS-on-CPU on every target.

### What the re-evaluation cannot promise, stated up front

| Case | Behaviour | Why |
|---|---|---|
| **Random draws** | The trace's random values are *its own* (a stream seeded per (element, generation), so re-tracing is stable); they are **not** the draws the engine made for that element. | On JS/WASM the shared stream's state at the element depends on every earlier cell's draws in the same generation; on WebGPU the per-cell PCG state lives on the GPU. |
| **Asynchronous update mode** | The trace evaluates the element against the **start-of-generation** state; the engine may have updated neighbours earlier in the same generation's order. Marked *approximate* in the trace header. | Single-buffer async semantics are order-dependent by design. |
| **f32 on WebGPU** | The trace is f64. Values can differ in the last bits. | Documented intentional difference of the WebGPU target. |
| **Everything else** (sync, non-random) | The trace's "next values" ARE what the engine writes — the JS reference is bit-identical to WASM. The panel shows the previous trace's prediction against the now-current values as a visible check. | |

---

## 2. The name

"Debug" is accurate but carries *the cell is broken* and *programmer* connotations; the app's public is
modellers, not programmers, and "Inspect" is taken by the value popover.

| Candidate | Reads as | Verdict |
|---|---|---|
| **Debug** | Fix a bug. Technical. | Acceptable fallback; the user said so. |
| **Trace** | *Follow the path of* — the literal thing the graph shows (the executed path lights up); "trace this cell", "tracing cell (12, 34)", "the trace of generation 412". Short, a verb and a noun, no "broken" connotation. | **Chosen.** |
| Follow | Already the camera-tracking button on the agent inspector. | No. |
| Watch | A debugger *watch list* is a different thing; "watch this cell" is fine but weak as a noun. | No. |
| Probe / X-ray / Walkthrough / Step through | Either too clinical or too long for a chip. | No. |

**Vocabulary used everywhere** (UI, Help, docs): the feature is **Rule Trace**; the button is **Trace**;
the chip reads **Tracing cell (r, c)** / **Tracing agent #id**; a pause point is a **breakpoint** (the
word every user who has ever seen a debugger knows — the tooltip says *"pause the trace when this node
runs"*); the controls are **Resume · Pause · Step generation · Step node · Back one node**.

---

## 3. The user-facing shape (what the plan builds)

1. **Entry.** In **Live** mode only, the cell inspector and the agent inspector (the popovers the
   user already opens with Shift+LMB / the Inspect toggle) carry a **Trace** button beside Close /
   Follow. One cell target and one agent target at a time (the two graphs are independent; a model
   with both has both). Pressing Trace on another element moves the target. Outside Live the button
   is **hidden** (the graph is not on screen — structurally impossible, the doctrine says hide).
2. **The target is marked** on the canvas (2D outline / 3D ring in the trace accent colour) and in
   the **Live bar** as a chip *"◉ Tracing cell (12, 34) ✕"* — the one place tracing is stopped from
   once the inspector is closed.
3. **The graph lights up.** For the graph on screen (cells or agents, and inside a macro scope), every
   node the traced element executed glows; the flow wires it took pulse; value wires it consumed light.
   Nodes it did not reach stay as they are. Values are on **hover**: a node → all its port values, a
   wire → the value it carried. When a *cursor* is set (stepping), the current node pulses stronger
   and only what has run *up to the cursor* is lit.
4. **The Trace panel** — a drawer along the bottom of the graph pane (the IDE debugger convention):
   a transport row (Resume ⏵ · Pause ⏸ · Step generation ⏭ · Step node ⤓ · Back ⤒), the
   **event timeline** (the recent traces: *gen 412 · Step*, *gen 412 · Output Mapping*, *gen 410 ·
   Brush*, *Reset · Init*…), and three tabs: **Values** (every attribute of the element: current →
   next, changed rows highlighted, plus engine writes such as forces, requests, indicators, stop),
   **Steps** (the executed nodes in order — click one to put the cursor there), **Breakpoints** (the
   list, with enable / remove).
5. **Breakpoints** are toggled from a node's context menu (*Breakpoint — pause the trace here*) and
   show as a red dot on the node. When the traced element reaches one, the simulation **pauses before
   that generation is applied**, the trace lands with the cursor on that node, and the board shows
   the state the rule is reading. Resume continues (the breakpoint fires once per generation).
6. **Other events** land in the timeline when they fire *for the traced element*: the per-cell Init
   on Reset, the Brush when a stroke hits it, an image import, the Output Mapping (its colour), the
   Grid / Population Periodic Events (global — traced whole), the Agent Init, the Division Event.

---

## 4. Decisions taken here

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | **Re-evaluation in the worker with a write-recording sandbox** (typed-array args wrapped in shadow proxies; function args replaced by recording stubs). | Instrumenting the engines (impossible on WASM/WGSL); an exact JS-only mode (a second mechanism for one target; the reference compile makes the re-evaluation exact wherever it matters). |
| D2 | **The trace is of the CURRENT state** ("the board you see → what it does next"), computed before a generation is applied. A breakpoint therefore pauses *before* the step. | Post-step traces of the previous state (the board on screen would not be what the trace read). |
| D3 | **One event log, presentation derives from it.** The worker ships events in execution order; the UI's cursor walks **flow** events and lights each flow node's value cone at the latest record ≤ the cursor. | Stepping through cell-top value records one by one (dozens of noise steps before the first flow node). |
| D4 | **The trace compile is the JS compiler with a `trace` option** — same passes, same lowerings, same ids — never a second interpreter. CSE and aggregate fusion are OFF in trace mode (so every node materialises a value); loop-invariance and sinking stay (a value sunk into an untaken branch simply has no record — which is the honest picture). | A separate walker (would diverge from the compilers' semantics — the exact bug class this repo documents most). |
| D5 | **Sampled while playing, every generation only when it must be**: with breakpoints set the worker traces every generation (it has to decide whether to pause); otherwise once per batch (once per frame). On WebGPU each trace reads the grid back (`ensureCpuAttrsFresh`) — a documented cost that only a breakpoint session pays per generation. | Always per generation (a W·H·D readback per generation on WebGPU at 5000² is not a debugging cost anyone should pay by default). |
| D6 | **Name = Trace.** | Debug (fallback), Watch, Follow. |
| D7 | **Panel = bottom drawer of the graph pane, only while a target exists.** | A left ActivityBar tab (Live closes those by policy — the panel would be one click away from the graph it annotates); a floating popover (too small for a values table). |
| D8 | **Breakpoints live in session state (the trace store), not in the `.gcaproj`.** | Persisting them (they reference node ids; a debugging aid does not belong in a shared model file). Revisit if asked. |
| D9 | **Values shown on hover, not painted on every wire by default.** | Always-on wire labels (a 300-node graph becomes unreadable). A "show on wires" toggle is a v2 candidate. |
| D10 | **A trace target survives a soft recompile and a paint; a structural rebuild keeps a cell target (same dims) and drops an agent target; a model load / new model drops both.** | |

---

## 5. Out of scope (recorded so nobody re-derives them)

- Conditional breakpoints, breakpoints on value nodes, data breakpoints ("pause when `energy` changes").
- Editing a value mid-trace and re-running from the cursor.
- Tracing several elements at once, or a whole neighbourhood.
- Recording a trace history to a file.
- Values painted permanently on wires (toggle) — v2.
- The Overseer graph (it is not a per-element rule; Live already excludes the Overseer).

# Plan — Bond-Graph Morphogenesis (the HOW-TO-BUILD-IT)

> **Status:** concrete implementation plan / deep-dive. This is the build playbook, not a feasibility study. It **builds on** [INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md) (the "BOND doc") and [INVESTIGATION_CENTER_BASED.md](INVESTIGATION_CENTER_BASED.md) (the "CB doc"). **It does NOT re-derive the substrate** — the agent SoA, the force-integration driver, the `maxCells`/free-list, the per-step neighbour rebuild, the `Δt` monotonicity hazard, the entity renderer, and the eigensolve division axis are all settled in those two docs and are cited (`BOND §N`, `BOND Dn`, `CB §N`, `CB #N`) rather than re-argued. This document answers the user's **four explicit questions**: how rules are authored (especially division), how the external environment couples in, how the Simulator interaction plays out, and how 3D visualization/navigation works — plus a concrete phased plan.
>
> **Scoping honesty (unchanged from the investigations).** Tier (I) — the entire center-based substrate — is itself **unbuilt**: there is zero `centerBased`/`maxCells`/`bondGraph`/free-list code in `src/` today. Every "reuse" below is reuse of *planned* CB machinery plus the *shipping* node-graph/compiler/simulator infrastructure that genuinely exists (verified firsthand at every `file:line` cited). Read the §7 Impact Map in that light.
>
> **Per CLAUDE.md ("Illustrated plans required for UI/behavior changes")**, an HTML mockup (`PLAN_BOND_GRAPH_MORPHOGENESIS.html`) accompanies this markdown for the new event roots, the division-rule editor, the simulator bond/agent brush, and the 3D viewport — a new mode is a non-trivial UI change.

---

## §1 — Executive summary

### The plan at a glance

GenesisCA already compiles a node graph to a per-cell step on three targets (JS/WASM/WebGPU). Bond-graph morphogenesis is an **additive extension of the *authoring model*** — no new authoring *concept*, just new event roots + nodes — but it is **not free on the compiler/engine side**: the agent-iteration loop on WASM/WebGPU, the post-step structural engine phase, and the agent+bond serializer are **genuinely new** (the net-new ledger, **§1.5** — read it before the "reuse" tags). The user authors *when/whether/how-much* to divide/grow/die/bond/secrete as ordinary attribute math wired into new flow nodes; the **engine owns all the geometry** (the division axis eigensolve, geometric bond reattachment, force integration, diffusion). The four user questions map to four build areas:

1. **Rule authoring (§2):** three new singleton **event roots** — a per-agent **Behaviour** root (mirrors [StepNode.ts:3-14](../src/modeler/vpl/nodes/StepNode.ts) but exposes self value-outputs `myX/myArea/myBondDegree/…`), a **Division** root (mirrors [InitEventNode.ts:16-31](../src/modeler/vpl/nodes/InitEventNode.ts) verbatim — `do` flow + value outputs), and a **Bond Contact** root (form/break decisions) — plus ~14 new read/flow nodes. The `divideCell` flow node emits a **request** into an engine-owned buffer (the [SetAttributeNode](../src/modeler/vpl/nodes/SetAttributeNode.ts) `w_<attr>[idx] = …` shape) that the post-step structural phase validates and applies.
2. **External environment (§3):** a **reaction-diffusion field** at the **main-grid resolution for v1** (Decision **D-FIELD**, §1.5 — a *second* compiled root reusing the [Gray-Scott Laplacian graph](../scripts/gen-grayscott.mjs); a *coarse* field at its own resolution is deferred, since the single-grid worker has one `total`/neighbour-table), **global env model-attributes** with live sliders (reuse [GetModelAttributeNode.ts:27](../src/modeler/vpl/nodes/GetModelAttributeNode.ts) + the `updateModelAttrs` worker handler), and an **interactive "paint into the field"** brush (clone of `paintManual`/`writeRegion`). All three feed the **same** force/behaviour graph as inline value nodes — there is no special "environment phase."
3. **Simulator interaction (§4):** nearest-agent picking behind a `Picker` seam (the only main-thread change — `screenToGrid`/`gridToScreen` at [SimulatorView.tsx:2320-2360](../src/simulator/SimulatorView.tsx) become the `2d-grid` impl); agent brush modes (seed/paint-attribute/kill/set-type) reusing the rAF paint coalescer; **bond brush modes** (drag-to-connect glue, segment-pick cut, region glue/cut) as a *second* pick target; an agent+bond inspector extending `postInspectCellsData` ([sim.worker.ts:2214](../src/simulator/engine/sim.worker.ts)).
4. **3D viz & navigation (§5):** a 2D entity renderer first (filled circles + bond line-segments, reusing the index-keyed `colors` buffer at [SimulatorView.tsx:1196](../src/simulator/SimulatorView.tsx)); then a **wholesale new WebGL2 instanced-sphere + bond-tube renderer** behind the same `draw()`/`srcCanvasRef` seam the WebGPU OffscreenCanvas direct-render path already proves ([webgpuRuntime.ts:502](../src/simulator/engine/webgpuRuntime.ts)); orbit camera, GPU colour-id picking, depth cueing, clip-plane slicing.

### The headline build sequence (each milestone has a visible demo)

| M | Demo you can see | New nodes / Impact rows |
|---|---|---|
| **M1** | Soft spheres push apart + integrate (2D circles render, no bonds yet) | CB substrate (CB Phases 0-2); `drawAgents()` (CB #27) |
| **M2** | Cells **glue into chains/clusters**; glue/cut by brush; bonds lock a sorted state | `FormBond`/`BreakBond` (D3); bond store (D1-D2, D8b); render+brush+inspector (D8e/D10); spring matrix (D9) |
| **M3 ★** | A glued cluster **grows and divides along its tension axis**, bonds inherited by geometry; division rules authored over the user's own attributes | `divideCell`, Division root, `GetBondDegree`/`NeighbourDensity`/`SummedBondStrength` (D12-D14); the rule editor |
| **M4** | The aggregate **branches under a chemotactic field**; painting a source/sink/wound perturbs it live | `SampleField`/`FieldGradient`/`SecreteToField` (D17-D18); `paintField` |
| **M5** | Repetitive branching/tubulation re-fires from passive curvature | `GetCurvature` + bent-beam strain (D19); the hysteretic-actuator macro (D20); (γ,χ) slider (D21) |
| **M6** | The whole thing in **3D** — orbit, slice into a tissue, pick a cell | WebGL2 instanced spheres + bond tubes + orbit + GPU-id pick |

Cross-target lockstep (JS → WASM → WebGPU) is observed per [feedback_compiler_lockstep] — but **per Decision D-TARGET (§1.5) v1 is JS-reference-only**: M1–M4 ship on the JS target, WASM is a later milestone (M5/M6), WebGPU is deferred (it rejects async, and bonds are sync-only). The two async-only constraints carry from the investigations: **bonds are sync-only in v1** (D11); the field's `SecreteToField` writes defer to the post-step structural phase (the [asyncWriteHazard.ts](../src/modeler/vpl/compiler/asyncWriteHazard.ts) class).

---

## §1.5 — Reuse honesty: what is genuinely NEW (read this before the "reuse" tags)

An adversarial review of an earlier draft caught a systematic over-claim: the plan kept calling things "verbatim template reuse" that are genuinely net-new on the WASM/WebGPU targets and the engine/serializer side. The honesty the §5 renderer section already applies ("3D-is-easy is true of the *engine*, not the *renderer*") must extend to the compiler and engine claims. So, up front:

**What genuinely reuses (verified at file:line):** the node-graph **authoring vocabulary** (value reads → `Compare`/`LogicOperator`/arithmetic → `Conditional`/`Sequence` flow), the **per-cell-step JS compiler's** root/flow-chain structure, the **index-keyed interaction protocol** (inspect/paint messages key cells by index), the `lookupTable` adhesion matrix, model-attribute sliders, and the colors buffer. These are real and shipping.

**What is genuinely NEW (NOT a template clone — cost these honestly):**

| # | Net-new work | Why it is not "reuse" |
|---|---|---|
| N1 | **The agent-iteration loop on WASM + WebGPU** | The JS compiler returns value/flow *lines* the caller wraps in a hand-written loop, so a JS agent loop is a genuine fork. But **WASM bakes `total = W*H` as a compile-time constant** ([wasm/compile.ts](../src/modeler/vpl/compiler/wasm/compile.ts)) and computes cells via lattice arithmetic; **WebGPU dispatches a workgroup over `layout.total` with W/H/sentinel as WGSL literals**. A variable-`liveAgentCount`, free-list-holed, continuous-position agent loop is a **new dispatch/loop structure** on both — not a fork of `compileEntry`. |
| N2 | **The post-step STRUCTURAL ENGINE PHASE** (division eigensolve + daughter placement + geometric bond reattachment; force integration; neighbour rebuild; free-list + epoch maintenance) | The plan grounds the *request emission* (`_divideRequest[idx]=1`) in `SetAttribute`'s shape, but the code that *consumes* the requests is entirely net-new worker code with no `file:line` precedent. This is the single largest new subsystem. |
| N3 | **The agent + bond SERIALIZER** (free-list with holes, ragged bond CSR, partner-id remap, slot epochs) | `serializeSimState` ([fileOperations.ts:388](../src/model/fileOperations.ts)) snapshots a fixed-length-`total` per-site SoA under `ATTR_TYPE_MAP`. A holey agent table + ragged bonds needing partner-remap-on-load is a **new serializer + validator**, not an extension. |
| N4 | **The engine-owned per-agent buffers** (`position x/y[/z]`, `radius`, `bondCount`, `curvature`, …) | These are **NOT** user attributes. Each needs its own dedicated `r_/w_` param pair gated into `buildLoopParams` — exactly like orientation's `r_orientation/w_orientation` at [compile.ts:1156](../src/modeler/vpl/compiler/compile.ts). `SetAttribute` writes `w_<userAttrId>[idx]` and **cannot** target them; growth/position are written by dedicated nodes (`SetTargetRadius`, the engine integrator), not `SetAttribute`. |
| N5 | **The WebGL2 3D renderer** (already honestly flagged in §5) | Wholesale new — instanced spheres + bond tubes + orbit + GPU-id picking behind the `draw()` seam. |

**Decision D-IDX — the index-variable contract (load-bearing; resolve before any rule node is built).** `GetCellAttributeNode.compile` hard-codes the literal string `'idx'` (`ctx.readAttrExpr(attr, 'idx')`, [GetCellAttributeNode.ts:15](../src/modeler/vpl/nodes/GetCellAttributeNode.ts)), and the literals `idx`/`_row`/`_col`/`colorIdx` appear ~67× across ~25 node files. **Decision: name the agent loop variable `idx`** (NOT `aIdx`) so all 25 nodes' hard-coded reads work as-is — `aIdx` is used in this doc only as *prose* for "the agent index." (The alternative — threading an `indexExpr` through `CompileContext` and editing ~25 nodes × 3 targets — is the expensive fallback, rejected for v1.) Wherever this doc writes `aIdx` in emitted code, read it as the loop's `idx`.

**Decision D-TARGET — the v1 compile-target matrix.** Per N1, the agent/bond/field nodes ship **JS-reference-only for M1–M4** (matching the "Debug/Reference (JS)" tier the renderer section already proposes for small N). **WASM is an explicit later milestone** (M5/M6 — porting the agent loop + structural-phase reads to the WASM emitter); **WebGPU is deferred** (it also rejects async, and bonds are sync-only — D11). A `detectWasmIncompatibilities`/`detectWebGPUModelIncompatibilities`-style gate ([nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts)) force-restricts a bond-graph model to JS until the WASM port lands. This bounds the per-milestone lockstep cost — the plan does **not** assume free tri-target parity for the ~14 new nodes.

**Decision D-FIELD — the field IS the lattice CA (upgraded — see §3.0).** The environment is **not** a bespoke field grid — it is a *normal GenesisCA lattice cellular automaton* (the field's rule authored with the full existing modeler — attributes, neighbourhoods, Step rule, init, colour mappings), and the agents live **suspended on top** with no lattice of their own. So there is **exactly one lattice grid** — the field — which is the worker's existing `width/height/total` + `buildNeighborIndices` ([sim.worker.ts:751,877](../src/simulator/engine/sim.worker.ts)), reused 100% for the field's compile / init / brush / colour-map / indicators / save — **plus** the agent tier. This **deletes the bespoke field subsystem and the "second grid" tension entirely** (the worker already runs multiple compiled functions — `stepFn`/`initFn`/`outputMappingFns`, [sim.worker.ts:369-376](../src/simulator/engine/sim.worker.ts); the field is the existing set, the agents add their own). The only new env code is the scatter/gather coupling bridge (§3.0). The field defines the world rectangle, so 1:1 is natural; a *coarse* field at a different resolution from the world is still deferred.

**Subsystem dispositions (so nothing reads as overlooked):**

| Subsystem | Disposition |
|---|---|
| Linked / spatial **indicators** | **Modify (M3+).** `computeLinkedIndicators` iterates the per-site SoA over `total`; over a free-list-holed agent set it must iterate `idx<highWater` skipping `!alive`. Non-trivial; scoped to when agents exist. |
| **End conditions** / StopEvent | **Reuse (M3).** Scalar/category indicator thresholds + `stopEvent` are index-agnostic; "one generation = one agent sweep" rescales `maxGenerations`. |
| **Recording** (GIF/WebM) | **Reuse (M1+).** Captures whatever `draw()` produces — once the entity/3D renderer lands, recording follows for free (confirm the bond/3D layers land in captured frames). |
| **Presentation .html export** | **Modify (post-v1).** Must bundle the entity/3D renderer + the structural engine phase + the agent/bond serializer, not the lattice simulator. |
| **Undo** of agent/bond brush ops | **New (M2).** Brush ops mutate the agent/bond store; needs its own snapshot stack (the graph-history `graphHistory.ts` pattern is the model, but over sim state). |
| **Save/load** agents+bonds (N3) | **New (M2).** Per the net-new ledger. |

---

## §2 — The rule-authoring model (the centrepiece)

This is the answer to the user's #1 question — *"how do I make division (and growth/death/bonding/secretion) depend on MY attributes?"* The answer is: **exactly as you author a Game-of-Life rule today.** No new authoring *concept* is introduced — only new event roots to hang rules on, new *read* nodes to sense the agent world, and new *flow* nodes that emit engine-validated requests. The decisive design principle (borrowed from PhysiCell's grammar and proven by the existing compiler): **the user composes arbitrary value-node math for the predicate; the engine owns the irreversible geometry.**

### 2.1 The event roots — where rules attach

A model's rules are a React-Flow graph compiled to per-event-root step functions. Today the singleton "event" entry-points are `Step` ([StepNode.ts](../src/modeler/vpl/nodes/StepNode.ts), `compile: () => ''`, the compiler handles roots specially), `InitEvent` ([InitEventNode.ts:16-31](../src/modeler/vpl/nodes/InitEventNode.ts), which additionally exposes value outputs `x/y/maxX/maxY`), `OutputMapping`, and `InputColor`. The compiler emits each root as its own per-cell loop — the InitEvent sibling-root block at [compile.ts:1857-1899](../src/modeler/vpl/compiler/compile.ts) is the **verbatim template** for a new root: find the node, `compileRoot`, wrap a per-iteration loop, splice the root's value-outputs in as preamble decls (`const _v${initId}_x = _col;`, [compile.ts:1888-1891](../src/modeler/vpl/compiler/compile.ts)).

Bond-graph morphogenesis adds **four event roots**, all `category: 'event'`, all `compile: () => ''`, all gated `requirements: { centerBased: true }` (or `bondGraph`):

| Root | Mirrors | Loop bound | Value outputs (preamble decls) | Fires |
|---|---|---|---|---|
| **`behaviourStep`** (the main per-agent update) | [StepNode.ts:3-14](../src/modeler/vpl/nodes/StepNode.ts) | `aIdx < highWater` (over the agent SoA, skip `!alive`) — **NOT** `idx < total` | `myX`,`myY`(,`myZ`), `myRadius`, `myArea`, `myBondDegree`, `myAge`, `myType` | once per live agent per generation |
| **`divisionEvent`** (daughter assignment) | [InitEventNode.ts:16-31](../src/modeler/vpl/nodes/InitEventNode.ts) **verbatim** | over the just-divided daughter set | `daughterIndex`∈{0,1}, `axisDefaultX`/`axisDefaultY` (the engine's eigensolve result), `myArea`, motherAttrs | once per (dividing agent, daughter) in the post-step structural phase |
| **`bondContactEvent`** (form/break policy) | [StepNode.ts](../src/modeler/vpl/nodes/StepNode.ts) shape | over candidate contact pairs the engine surfaces | `otherType`, `restLength`, `currentLength`, `currentStrain`, `myBondDegree`, `otherBondDegree` | per candidate pair, post-step |
| **`fieldStep`** (§3 — the field's own diffusion) | [StepNode.ts](../src/modeler/vpl/nodes/StepNode.ts) | `idx < fieldW*fieldH` (a **lattice** — this one keeps row/col) | (the field is a grid; reuses existing reads) | per field voxel, K sub-steps per agent step |

**The one structural deviation from the existing compiler** ([CB §7.1], grounded at [compile.ts:1748-1752](../src/modeler/vpl/compiler/compile.ts)): the agent roots (`behaviourStep`/`divisionEvent`/`bondContactEvent`) emit a loop over `aIdx < highWater` with **no** `_row`/`_col` decode and **no** `colorIdx = idx*4` (rendering is entity-based, not a lattice blit). The `fieldStep` root keeps the existing lattice preamble verbatim — it *is* a grid. So every agent root forks the loop-preamble block; the field root does not.

`readAttrExpr` (the read chokepoint, [types.ts:47-62](../src/modeler/vpl/types.ts) + [compile.ts:391-416](../src/modeler/vpl/compiler/compile.ts)) works for agent attributes **only because the agent loop variable is named `idx`** (Decision **D-IDX**, §1.5) — `GetCellAttribute` hard-codes `ctx.readAttrExpr(attr, 'idx')` ([GetCellAttributeNode.ts:15](../src/modeler/vpl/nodes/GetCellAttributeNode.ts)), and the literal `idx` appears ~67× across ~25 node files, so reads land on `r_<attr>[idx]` against the agent SoA **with no node change** — but this is *contingent on the `idx` naming*, not free template reuse. Two caveats: (1) engine-owned buffers (position/radius/bondCount — **N4**, §1.5) are NOT user attributes and are read by dedicated nodes, never `GetCellAttribute`; (2) sub-attribute parent-guards and the neighborIndex codec ([MoveSelfToNeighborNode.ts:67](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts) `niCellExprStmts`) are lattice-specific and must NOT be invoked from agent-world nodes.

### 2.2 Worked example A — "divide when age > T and size > X, orient by tension, give daughter A more of attribute Q"

This is the user's literal request. It is authored with **zero new mechanisms** beyond the new roots/nodes — every connective tissue (`GetCellAttribute`, `Compare`, `LogicOperator`, `Conditional`) ships today.

The user has defined cell attributes (in the Attributes panel, [src/model/types.ts:25-88](../src/model/types.ts)): `age` (integer), `size` (float, = the engine radius or a user proxy), `Q` (float — some morphogen the user invented). The rule lives in **two graphs**: the WHEN gate on `behaviourStep`, and the daughter assignment on `divisionEvent`.

**Graph 1 — the WHEN gate (on `behaviourStep`):**

```
behaviourStep ──do──┐
                    │
GetCellAttribute(age) ──┐
                        ├─ Compare(op:">", y=T) ──┐
GetConstant(T) ─────────┘                         ├─ LogicOperator(AND) ──┐
                                                  │                       │
GetCellAttribute(size) ─┐                         │                       │
                        ├─ Compare(op:">", y=X) ──┘                       │
GetConstant(X) ─────────┘                                                 │
                                                                          ▼
                                                       Conditional.condition ── then ──▶ divideCell
                                                                                            { axisSource: "tension" }
```

- `Compare` is the `statement` node ([StatementNode.ts], label "Compare") — it emits a bool `_v<id> = (x op y)`.
- `LogicOperator(AND)` and `Conditional` (`if(cond){…}`, [compile.ts:918-938](../src/modeler/vpl/compiler/compile.ts)) ship today.
- `divideCell` is a **new flow node** shaped like [SetOrientationNode.ts:21-24](../src/modeler/vpl/nodes/SetOrientationNode.ts) (`{ do, input, flow }`, `{ next, output, flow }`) **plus** optional value inputs `axisX`/`axisY` (wired only to override the engine axis) and `asymmetry`∈[0,1]. Its `compile()` emits a **request** into an engine-owned per-agent buffer — the exact `w_<attr>[idx] = <value>` RMW shape of [SetAttributeNode.ts:15-20](../src/modeler/vpl/nodes/SetAttributeNode.ts):

```js
// divideCell.compile() — emits into engine-owned request buffers (aIdx = agent index)
_divideRequest[aIdx] = 1;
_divideAxisX[aIdx]    = (axisXWired ? <axisExpr> : NaN);   // NaN ⇒ "use the engine eigensolve"
_divideAxisY[aIdx]    = (axisYWired ? <axisExpr> : NaN);
_divideAsym[aIdx]     = <asymExpr>;                        // default 0.5
```

The engine's post-step structural phase reads `_divideRequest`, computes the **tension-proxy eigensolve axis** (BOND §3.1 — `M = Σ_k w_k·(r̂_k⊗r̂_k)`, principal eigenvector; degenerate fallback to the density-gap minor eigenvector), blends in the user override if present, splits the mother at `centroid ± ½·offset·m̂`, partitions bonds geometrically (BOND §3.2 — each partner to the nearer daughter by `sign(dot(offset_k, m̂))`), adds the daughter-daughter bond, and allocates a free-list slot (rejecting + surfacing on `maxCells`/`maxBonds` overflow, BOND §3.4/D4/D14). **The graph never sees the per-bond partition decision** — this is the precise freedom/guardrail boundary.

**Graph 2 — daughter A gets more of Q (on `divisionEvent`):**

```
divisionEvent ──do──┐
                    │
(value out) daughterIndex ──┐
                            ├─ Compare(op:"==", y=0) ── then ──▶ SetAttribute(Q, value = motherQ * 0.7)
GetConstant(0) ─────────────┘                          else ──▶ SetAttribute(Q, value = motherQ * 0.3)
```

The `divisionEvent` root fires once per (dividing agent, `daughterIndex`∈{0,1}) and exposes the mother's attributes as readable value-outputs (the engine snapshots them before the split). Daughter-0 keeps 70% of `Q`, daughter-1 keeps 30% — an **asymmetric inheritance** authored as two `SetAttribute` writes. If no `divisionEvent` is wired, **both daughters inherit verbatim** and `divideCell.asymmetry` splits `size`. This reuses the InitEvent compile mechanism ([compile.ts:1857-1899](../src/modeler/vpl/compiler/compile.ts)) — the `divisionEvent` is literally *"InitEvent, but its loop runs over the daughter set and its preamble exposes `daughterIndex` + motherAttrs instead of `x/y/maxX/maxY`."*

**Concentration-vs-count caution (BOND §3.3, D16):** if `Q` is a field-coupled morphogen *count*, the engine splits it with the volume ratio automatically (concentration preserved); the user's `*0.7`/`*0.3` is an *additional* asymmetry on top. Document this so the user isn't surprised.

### 2.3 Worked example B — "extrude (die) when curvature < 0 and bondDegree < 2"

A one-wired-predicate death rule mixing two new sensed inputs (on `behaviourStep`):

```
GetCurvature(channel:"lateral") ──┐
                                  ├─ Compare(op:"<", y=0) ──┐
GetConstant(0) ───────────────────┘                        ├─ LogicOperator(AND) ── then ──▶ killCell
                                                            │
GetBondDegree ──┐                                           │
                ├─ Compare(op:"<", y=2) ───────────────────┘
GetConstant(2) ─┘
```

`killCell` emits `_killRequest[aIdx] = 1`; the engine recycles the slot, **breaks all bonds to and from** the dying agent, and bumps the slot epoch (BOND D8b — the dangling-bond ABI). `GetCurvature` and `GetBondDegree` slot into the *same* Compare/arithmetic graphs as any attribute read — that is the whole point of making them first-class data nodes.

### 2.4 Worked example C — "form a bond on contact if same type and not over-bonded" (on `bondContactEvent`)

```
bondContactEvent ──do──┐
                       │
(value out) otherType ──┐
                        ├─ Compare(op:"==", y = myType) ──┐
(value out) myType ─────┘                                 ├─ LogicOperator(AND) ── then ──▶ formBond
                                                          │                                  { typeLabel: "adhesive" }
(value out) myBondDegree ─┐                               │
                          ├─ Compare(op:"<", y = maxBonds) ┘
GetModelAttribute(maxBonds)┘
```

`formBond` resolves the partner, guards `alive && partnerBondDegree < maxBonds && myBondDegree < maxBonds`, and writes the bond record into the **bond-request buffer** — the [MoveSelfToNeighborNode.ts:64-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts) resolve→guard→RMW shape, with the guard gaining a `maxBonds`-overflow **reject** (never wrap). The per-type-pair spring stiffness `λ` and rest length `L` come from the existing **`lookupTable` model attribute** (two value channels, BOND D9) — no new attribute type. **Hysteresis is engine-enforced** (BOND D5): the engine forms at `d_form` and breaks at `d_break > d_form`; the user authors the *policy* predicate, not the thresholds.

### 2.5 The new read nodes (sense the agent/bond/field world)

All are `category: 'data'`, gated `requirements.centerBased`/`bondGraph`, each emitting one `const _v${id} = <buffer>[aIdx];` — the [GetCellAttributeNode.ts:13-17](../src/modeler/vpl/nodes/GetCellAttributeNode.ts) shape. The worker supplies each buffer in `buildLoopParams` ([compile.ts:1132-1162](../src/modeler/vpl/compiler/compile.ts)) under the bond-graph gate — cloned from the `if (variegated || hasLookupTables)` param-append at [compile.ts:1156](../src/modeler/vpl/compiler/compile.ts).

| Node | Emits | Reads / writes | Root(s) it makes sense on |
|---|---|---|---|
| **GetBondDegree** | `_agentBondCount[aIdx]` | engine bond-count buffer | behaviour, division, bondContact |
| **SummedBondStrength** / **MeanBondStrength** | a worker-precomputed per-agent reduction, OR a `ForEachBond` body sum | bond store | behaviour, division |
| **GetCurvature**(channel) | `_agentCurvature[aIdx]` (engine fits the bond fan; `lateral` vs `topographical` channel via `hiddenPorts`, like [GetModelAttributeNode](../src/modeler/vpl/nodes/GetModelAttributeNode.ts)'s R/G/B) | engine curvature buffer | behaviour, division |
| **NeighbourDensity** | `_agentDensity[aIdx]` | engine density buffer | behaviour, division |
| **SampleField**(channel) | `_field_<sub>[fieldVoxelOf(aIdx)]` (bilinear) + optional ∇c | field grid (read) | behaviour, division |
| **FieldGradient**(channel) | two value ports `∂c/∂x`, `∂c/∂y` (3D: +z) | field grid (read) | behaviour (chemotaxis), division |
| **GetSelfPosition** | `_agentX[aIdx]`, `_agentY[aIdx]`(,z) — multi-output | position SoA | behaviour, division |
| **GetBondedNeighbourAttr**(bondSlot, attrId) | a partner agent's attribute via the bond list | bond store + partner SoA (the [GetNeighborAttributeByIndexNode.ts:23-43](../src/modeler/vpl/nodes/GetNeighborAttributeByIndexNode.ts) IIFE-guarded read, indexing the bond store not a packed NI) | behaviour |
| **GetRadius** | `_agentRadius[aIdx]` (CB §7.2) | radius SoA | behaviour, division |

**Multi-output discipline (per CLAUDE.md):** `SampleField`-with-gradient, `GetSelfPosition`, and the Division root's value-outputs need a `varName()` special-case in compile.ts plus scratch/cache registration on all three targets. The InitEvent `x/y/maxX/maxY` preamble decls ([compile.ts:1888-1891](../src/modeler/vpl/compiler/compile.ts)) are the simplest precedent — fixed preamble decls, no port resolution.

**Critical gotcha (BOND §9.1 #7 / D13):** `GetBondDegree`/`NeighbourDensity`/`GetCurvature` MUST be **first-class nodes, not an `Average`-over-the-bond-list macro** — `Average` equals density only when the array length equals the degree, which is false for a ragged bond list with holes. `detectMissingConfig` ([nodeValidation.ts:61](../src/modeler/vpl/nodes/nodeValidation.ts)) must require their config (channel selection) like every other configured node, or the compiler silently emits `_undef`.

### 2.6 The new structural flow nodes (emit requests, not direct writes)

All are `category: 'output'`, gated `requirements.bondGraph`. **Unlike `MoveSelfToNeighbor` they are NOT async-only** (BOND §5.2) — they emit a write into an engine-owned *request* buffer that the post-step structural phase validates and applies, so there is no read-after-write hazard during the force pass. Do **not** blindly copy `MoveSelfToNeighbor`'s `requirements: { async: true }` ([MoveSelfToNeighborNode.ts:43](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts)).

| Node | Emits | Engine action (post-step structural phase) |
|---|---|---|
| **divideCell**(axisSource, asymmetry?, axisX?, axisY?) | `_divideRequest[aIdx]=1; _divideAxis*[aIdx]=…; _divideAsym[aIdx]=…` | eigensolve axis → split → geometric bond partition → free-list append (reject on `maxCells`/`maxBonds`) |
| **killCell** | `_killRequest[aIdx]=1` | recycle slot + break-all-bonds + bump epoch (D8b) |
| **formBond**(targetAgent, restLength?, stiffness?, typeLabel?) | bond-request buffer write (resolve→guard→RMW, [MoveSelfToNeighborNode.ts:64-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts)) | append a bond both directions; reject on `maxBonds` |
| **breakBond**(targetAgent \| bondSlot) | bond-request buffer write | remove the bond both directions |
| **setTargetRadius**(value) | `w_radius[aIdx] = <value>` (literally [SetAttributeNode.ts](../src/modeler/vpl/nodes/SetAttributeNode.ts) on the engine-owned radius) | radius ramps toward target over the cycle |
| **secreteToField**(substrate, rate) | scatter into the field write buffer (§3) | bilinear 4-voxel splat, post-step |

**ForEachBond** — a clone of [ForEachInArrayNode.ts:3-21](../src/modeler/vpl/nodes/ForEachInArrayNode.ts) whose "array" is the agent's ragged bond list, exposing `partnerId`/`restLength`/`currentLength`/`strength`/`index` per iteration. Compile it by adding a `bondList` source kind to the forEach dispatch at [compile.ts:961-977](../src/modeler/vpl/compiler/compile.ts):

```js
for (let _feb<id> = 0; _feb<id> < _agentBondCount[aIdx]; _feb<id>++) {
  const _bondBase = aIdx * maxBonds + _feb<id>;
  const partnerId = _bondPartner[_bondBase];
  const restLength = _bondRestLen[_bondBase];
  // … body emits ordinary value-node math (e.g. spring force λ(l−L)·r̂ summed into a Local Variable)
}
```

The per-bond spring force `λ(l−L)·r̂` is then ordinary arithmetic summed into a Local Variable ([types.ts:501-518](../src/model/types.ts)) — bonds add an iteration **source**, not a new emit **kind** (BOND §5.3).

### 2.7 Freedoms vs guardrails — the crisp boundary

| Decision | User composes (FREEDOM) | Engine owns (GUARDRAIL) | Grounding |
|---|---|---|---|
| **WHEN to divide/grow/die** | any boolean graph over their attributes + sensed inputs (`GetBondDegree`, `GetCurvature`, `NeighbourDensity`, `SampleField`, `age`, model attrs) → `divideCell`/`killCell`/`setTargetRadius` | nothing — this is pure authoring | BOND §4 |
| **Division AXIS** | the axis **source** (a `divideCell` dropdown: `tension`/`density`/`field-gradient`) + an optional `axisX`/`axisY` value-input override | the tension-proxy **eigensolve** (`Σ tension⊗tension` → principal eigenvector + density-gap degenerate fallback); projects/normalises any user override | BOND §3.1 |
| **Bond PARTITION at division** | nothing — forbidden by construction | each partner → the **nearer daughter** by `sign(dot(offset, axis))`; exactly one new daughter-daughter bond | BOND §3.2 |
| **Daughter ATTRIBUTES** | arbitrary `SetAttribute` writes on the `divisionEvent` root keyed by `daughterIndex` (differentiation, morphogen split, size asymmetry) | concentration-vs-count split of field-coupled counts by volume ratio | BOND §3.3, §2.2 |
| **Bond FORM/BREAK policy** | type-compatibility + strain + distance predicates → `formBond`/`breakBond`; the bond-class labelling | hysteresis (`d_form < d_break`); the `maxBonds` ceiling (reject, never wrap) | BOND §5.2, D4-D5 |
| **Adhesion/spring MATRIX** | `λ`, `L` per type-pair via the `lookupTable` editor (live-tunable) | the spring law `λ(l−L)·r̂`; the short-range repulsion-dominates invariant | BOND D9, §5.1 |
| **Force MAGNITUDE law** | the repulsion-then-adhesion curve as nodes (`Compare`/`Interpolation`/arithmetic) | the **vector reduction** `Σ F(d)·r̂` + integration + the `Δt` monotonicity clamp + free-list + per-step neighbour rebuild | CB §7.1, BOND §5.3 |
| **Field chemistry** | the reaction-diffusion graph (`GetNeighbors→Aggregate.Sum→expression→SetAttribute`) + `SecreteToField`/`SampleField` | field SoA allocation, double-buffer, K-substep CFL clamp, bilinear sample math | §3 |

**The single sentence:** the user authors *every predicate and every attribute value* (WHEN/WHETHER/HOW-MUCH); the engine owns *every irreversible geometric operation* (the physically-realizable axis, bond reattachment, force integration, diffusion). A rule emits **requests** into engine-owned buffers (`_divideRequest`/`_killRequest`/`_bondFormReq`) that the structural phase validates — a rule can never directly corrupt the agent/bond store, mirroring how [SetOrientationNode.ts:21-24](../src/modeler/vpl/nodes/SetOrientationNode.ts) writes an engine-managed buffer the user never sizes or frees.

**Honesty guardrail the UI must enforce (BOND §3.1 gotcha):** the faithful Hertwig *shape* long-axis is **uncomputable** in center-based (a sphere has no shape) — only the *tension* proxy exists. The `divideCell.axisSource` dropdown must NOT offer a "shape long-axis" option (it would silently fall back to tension and mislead). Label it honestly: **"tension axis."**

---

## §3 — The external environment

The user's question: *"how can cells be affected by external environment on top of the internal interactions?"* GenesisCA already has **three of the four** environment layers as verified node-graph/worker patterns; the bond-graph mode reuses all four by re-targeting them at agents. **The decisive design property to preserve: external env and internal rules share ONE graph — there is no "environment phase."**

### 3.0 The big simplification — the field IS a cellular automaton (reuse the whole CA engine)

**The user's insight (adopted as the architecture): don't build a bespoke field subsystem — make the environment a *normal GenesisCA lattice CA*, and let the agents live suspended on top of it.** The user authors the **field's rule** with the entire existing modeler (attributes, neighbourhoods, the Step rule graph, init events, color mappings), then authors the **cells' rule** with the new agent event roots (§2). This is strictly better than the bespoke `FieldConfig` + hardcoded Gray-Scott of the earlier draft, for one decisive reason: **everything the environment needs already exists and is mature.**

| The field, being a CA, gets for FREE | Reused from |
|---|---|
| Arbitrary per-voxel attributes + **any** update rule (not just reaction-diffusion — excitable media, ECM with degradation, flow, Turing, nutrient with complex dynamics) | the existing attribute system + the Step compiler on all 3 targets |
| **Initialization** — InitEvent procedural seeding, **image import**, **brush painting**, randomize, default values | `initFn`, `importImage`, `paint`, Color→Attribute mappings ([sim.worker.ts:376,1790; the InputColor path:2503](../src/simulator/engine/sim.worker.ts)) |
| **Visualization** — Attribute→Color mappings, the colors-buffer blit, viewer tabs | `outputMappingFns` + the `ImageData` blit ([sim.worker.ts:1799-1803](../src/simulator/engine/sim.worker.ts), the existing render) |
| **Interaction** — paint a chemoattractant/wound/nutrient source with the existing brush | the Color→Attribute brush + `paint`/`paintManual` |
| Indicators, save/load, recording, presentation export | the existing per-site machinery — all already work on a lattice |

**This is the PhysiCell + BioFVM architecture** (discrete agents over a separate continuum field grid), but with GenesisCA's CA engine *as* the field solver — a clean, literature-matching split. **And the lattice engine is no longer "abandoned" (the framing in CB §2.1): it becomes the environment.** Only the *agent* rules need the new loop shape (N1); the *field* rules compile through the existing per-site path **100% unchanged**.

**The worker already supports it.** It holds and runs **multiple compiled functions** today — `stepFn`, `initFn`, `inputColorFns[]`, `outputMappingFns[]` ([sim.worker.ts:369-376, 1786-1803](../src/simulator/engine/sim.worker.ts)), each fired at its own time. The field is the **existing** `stepFn`/`initFn`/mapping set over the lattice; the agents add their **own** function set (`behaviourFn`, division/bond/integration in the structural phase). Two engines, one worker, one generation loop — the orchestration is new, but each engine exists.

**The model shape:** a morphogenesis model = a normal **substrate CAModel** (the field — could even be an *imported library model*: drop cells onto Gray-Scott, an excitable medium, or a nutrient CA) **+** an **agent layer** (the cells, with their bond-graph rule graph). The field is OPTIONAL — pure cell-sorting needs no field (agents only).

**The coupling = a small, well-defined bridge (the only genuinely new env code):**
- **Agent → field (scatter / "deposit"):** an agent writes into a dedicated field **source attribute** at its voxel — `SecreteToField(substrate, rate)` → `w_fieldSource[voxelOf(agent)] += rate` (a 4-voxel bilinear splat, accumulate). The field's *own* CA rule then reads `fieldSource` as an ordinary attribute input (diffuse/react/decay). Using a **distinct** source attribute (not the diffusing one) sidesteps the read-after-write aliasing — agents own-write `source`, the field reads it. Multiple agents → one voxel is the accumulate-discipline of the existing async neighbour-write hazard.
- **Field → agent (gather):** `SampleField(attr)` / `FieldGradient(attr)` read the field attribute (bilinear) at the agent's continuous position — §3.1's two new value nodes, the *only* new field emit.
- **Field reads agents (optional, for full bidirectionality):** agents scatter a per-voxel **occupancy/density** the field rule reads via a `GetAgentDensityHere` node — so the field CA can respond to where cells are (ECM deposition, contact guidance, a laid-down trail).
- **Coordinate map + boundary:** the field's `W×H` defines the world rectangle; an agent at `(x,y)` maps to voxel `(⌊x⌋,⌊y⌋)`; agents share the field's boundary treatment (torus wrap / wall).

**Scheduling (per generation):** agents *deposit* → the field CA steps (its own rate: K sub-steps via a model attr) → agents *sense* + run Behaviour + integrate forces + structural events. The field's double-buffer keeps its own read/write clean; the bridge attributes (`source`, the diffusing substrate) are distinct, so no cross-engine aliasing.

**Honest costs (this is a simplification, not free):** (1) two engines orchestrated in one worker (new generation-loop sequencing); (2) the scatter (agent→voxel accumulate) + the gather (bilinear) are new; (3) a **naming disambiguation** — today "cell attribute" = per-voxel; with agents present, "cell" overloads (voxel vs agent), so the UI must distinguish **field/voxel attributes** from **agent attributes**; (4) the field is a **lattice**, so a 3D field is a 3D CA (a volume — heavier, and volume rendering is hard; 2D is clean: field blit under the agent overlay, exactly Demo 03); (5) the field runs at full CA cost (keep it coarse if the tissue is small); (6) agents must respect the field's world bounds. None of these is a new *engine* — they are integration glue over two engines that both exist.

**What this changes in this plan:** §3.1 below (the reaction-diffusion field) becomes **one example field rule** (the user wires Gray-Scott, or anything else) rather than a hardcoded subsystem; **Decision D-FIELD (§1.5) is upgraded** — there is no "second grid" tension because the field *is* the one lattice grid the worker already owns, and the agents carry no lattice at all.

### 3.1 The reaction-diffusion field — now just ONE example field-CA rule (v1: the main-grid resolution)

**Storage.** Add `model.fieldEnvironment?: FieldConfig` (a sub-object cloned structurally from [VariegatedCellsConfig, types.ts:470-483](../src/model/types.ts)): `{ enabled, fieldWidth, fieldHeight, substrates: FieldSubstrate[] }` where `FieldSubstrate = { id, name, diffusion, decay, initialValue, secretionAttrId? }` (mirrors [FaceLabelPalette, types.ts:444-451](../src/model/types.ts)'s id/name/array shape). The worker allocates **one `Float64Array` per substrate of length `fieldW*fieldH`**, double-buffered like the per-site cell SoA. **Decision D-FIELD (§1.5): v1 pins `fieldWidth = gridWidth`, `fieldHeight = gridHeight` (1:1)** — this is what makes the existing `buildNeighborIndices` table (sized to the global `total`, [sim.worker.ts:877](../src/simulator/engine/sim.worker.ts)) reusable for the field's Laplacian gather **unchanged**. A *different* (coarse) field resolution would need its OWN neighbour table + field-specific loop params — a second grid the single-grid worker cannot represent today, so it is **deferred**. **The field is still a SEPARATE iteration domain from agents** — agents are `length maxCells` indexed by agent-id; the field is `length total` indexed by voxel. Conflating them re-introduces the lattice-vs-agent index confusion the CB doc warns about (CB §1).

**Diffusion + reaction = the existing Gray-Scott graph, ZERO new compiler emit.** The field's own diffusion is the `fieldStep` root (§2.1), authored as nodes **verbatim** like [scripts/gen-grayscott.mjs:100-168](../scripts/gen-grayscott.mjs):

```
getNeighborsAttribute(field neighbours) ──▶ aggregate.sum  ──▶ expression(D·∇²c − λ·c + reaction) ──▶ setAttribute(field write)
        (the 9-point Laplacian gather)        (Laplacian)         (Euler step, D/λ are model attrs)
```

Gray-Scott already proves the compiler + 3 targets express Laplacian + reaction + Euler on a grid (`getNeighborsAttribute` gather at [gen-grayscott.mjs:100-103](../scripts/gen-grayscott.mjs), `aggregate.sum` at :106-113, the reaction `expression` at :131, the Euler `expression` at :136-160, the `setAttribute` write at :163-168, `Du/Dv/F/k/dt` as model attrs at :94-98). The worker runs `fieldStep` **K sub-steps per agent step** (a `fieldSubSteps` model attr — clamp the explicit-diffusion CFL, CB §2.5). **The field needs no new compiler emit** — it is the existing per-site step retargeted at the field SoA, wired into `buildLoopArgs` the way `step` is ([sim.worker.ts:937-963](../src/simulator/engine/sim.worker.ts)).

**The two genuinely new nodes** (the agent↔field coupling — the only new field emit):

- **SampleField**(substrateId) — gather the field value at an agent's continuous `(x,y)`. The agent is at a float position, so it **cannot** use `getNeighborsAttribute`'s fixed-stride lattice table ([GetNeighborsAttributeNode.ts:24-31](../src/modeler/vpl/nodes/GetNeighborsAttributeNode.ts)) — `SampleField` emits a **bilinear interpolation** over the 4 surrounding voxels using `fieldW`/`fieldH` baked literals (`fx = x*fieldW/worldW`, lerp `field[iy*fieldW+ix]` …). This is the off-lattice analogue of [GetModelAttributeNode.ts:27](../src/modeler/vpl/nodes/GetModelAttributeNode.ts) (a value read) but indexed by *position* instead of a constant id. **This bilinear interpolation is the one genuinely new value emit in the entire field subsystem.**
- **FieldGradient**(substrateId) — output `∇c = (∂c/∂x, ∂c/∂y)` as two value ports (3D: +z) via central differences over the same bilinear sample. This is the **chemotaxis primitive**: `FieldGradient → normalize → migration-bias force` composes into the agent force reduction with no special casing.
- **SecreteToField**(substrateId, rate) — a flow node, the [MoveSelfToNeighborNode.ts:70-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts) resolve→guard→RMW shape: resolve the agent's voxel index from `(x,y)`, guard `0 ≤ vidx < fieldW*fieldH`, then `w_field_<sub>[vidx] += rate` (mass-conserving = a bilinear 4-voxel splat). **Must run in the post-step structural phase** (many agents write a shared voxel → the [asyncWriteHazard.ts](../src/modeler/vpl/compiler/asyncWriteHazard.ts) read-after-write class). Sources/sinks are just positive/negative secretion — Nelson's two branching logics (chemoattraction vs autocrine chemorepulsion, BOND §6.1) fall out.

### 3.2 Global environment = model attributes + live sliders (zero new code)

Nutrient/temperature/gravity are bounded `float` **model attributes** (`isModelAttribute`, [types.ts:30](../src/model/types.ts); `hasBounds`/`min`/`max`, [types.ts:39-43](../src/model/types.ts)). The user reads them in the force/behaviour graph with `getModelAttribute` (`const _v<id> = modelAttrs[<id>]`, [GetModelAttributeNode.ts:27](../src/modeler/vpl/nodes/GetModelAttributeNode.ts)). The simulator's existing Model Attributes panel renders a live range slider ([SimulatorView.tsx:3739-3760](../src/simulator/SimulatorView.tsx)) and `handleModelAttrChange` posts `updateModelAttrs` ([SimulatorView.tsx:3164-3166](../src/simulator/SimulatorView.tsx)) which the worker applies **with no recompile and no pause** — re-caching `cachedModelAttrs` ([sim.worker.ts:646](../src/simulator/engine/sim.worker.ts)) and re-syncing to WASM memory + the WebGPU uniform ([sim.worker.ts:3008-3019](../src/simulator/engine/sim.worker.ts)).

A **gravity vector** is two model attrs `(gx, gy)` added straight into the agent force sum. **Nothing new is required for the global env tier** — the design is to document this as the canonical mechanism and seed the example model with a couple of env attrs.

**Gotcha:** a bounded slider needs **all three** of `hasBounds`/`min`/`max` set ([SimulatorView.tsx:3739](../src/simulator/SimulatorView.tsx) gates the range slider on `a.hasBounds && a.min != null && a.max != null`) — omit any and it silently falls back to a bare `NumberField` with no slider.

### 3.3 Interactive environment = "paint into the field" brush

Add a `paintField` worker message `{ type: 'paintField', substrateId, cells: [{vrow, vcol}], delta, mask? }`, modelled on `paintManual` ([sim.worker.ts:2591](../src/simulator/engine/sim.worker.ts)) + `writeRegion`'s mask loop ([sim.worker.ts:3327-3354](../src/simulator/engine/sim.worker.ts)): for each masked voxel, `field_<sub>[vidx] += delta` (positive = chemoattractant source / nutrient drop; negative = sink). On the UI side, add a field-brush mode to the simulator brush strip — the brush-shape + shape-mask machinery already exists (CLAUDE.md "Shape-aware cell copy/paste"). A **wound** is the same brush deleting agents (the agent free-list death event, §4) + zeroing the field locally.

**Live-update parity (gotcha):** any new live field-parameter message must re-cache AND re-sync to WASM memory + WebGPU buffers (the `updateModelAttrs`/`updateLookupTable` three-sync discipline, [sim.worker.ts:3012-3018](../src/simulator/engine/sim.worker.ts)), and the lookupTable view discipline is strict — **copy into the existing wasmMemory view, never reassign** ([sim.worker.ts:3028-3037](../src/simulator/engine/sim.worker.ts)).

### 3.4 Composition — one graph, no env phase (the headline property)

SampleField/FieldGradient (field), getModelAttribute (global), and GetBondDegree/GetCurvature/self-attr reads (internal) are **ALL ordinary value nodes feeding the SAME force/behaviour root.** A division predicate like:

```
SampleField(nutrient) ──┐
                        ├─ Compare(">", threshold) ──┐
getModelAttribute(threshold) ┘                       ├─ LogicOperator(AND) ── then ──▶ divideCell
                                                     │
GetBondDegree ──────────────── Compare("<", maxBonds) ┘
```

wires field + global + bond reads into one Compare/Statement chain exactly as Gray-Scott wires reads + model-attrs into one `expression` ([gen-grayscott.mjs:136-160](../scripts/gen-grayscott.mjs)). **There is no "environment pass"** — the field is a *separate root* for its own diffusion, but agents READ it inline. The design must NOT introduce a special environment-evaluation order.

### 3.5 Worked example — nutrient-limited growth + chemotaxis branching

A complete v2-autonomy graph (on `behaviourStep`):

```
# Growth gated by local nutrient (Okuda activator-as-mitogen Hill gate)
SampleField(nutrient) ──▶ expression( λ_ref · c^α / (ρ^α + c^α) )  ──▶ setTargetRadius   # grow fast where nutrient high

# Division toward the nutrient gradient (chemotaxis branching)
SampleField(nutrient) ──┐
                        ├─ Compare(">", divideThreshold) ── then ──▶ divideCell { axisSource: "field-gradient" }
GetModelAttribute(divideThreshold) ┘                                          (engine reads FieldGradient for the axis)

# Each agent consumes nutrient (sink) — the necrotic-core / spacing driver emerges
SecreteToField(nutrient, rate = −uptakeRate)
```

Cells grow where nutrient is high, divide up the gradient (the filament extends toward the source), and **consume** nutrient as they go — so the trailing region depletes, the gradient steepens at the tip, and **branching emerges from the coupling, not a script** (Nelson; BOND §6.1). Surfacing the morphology selector is the **(γ,χ) slider** (BOND §6.2, D21) — one bounded model attribute that walks the user through undulation/tubulation/branching. **Serialization parity (BOND §7 / CB #41):** the field SoA serializes as base64 typed arrays alongside the agent table; substrate diffusion/decay are model attrs so they already ride `presets.state.modelAttrs` ([gen-grayscott.mjs:284](../scripts/gen-grayscott.mjs)). **Validate field length == `fieldW*fieldH` on load and reject loudly** (the no-try/catch silent-abort hazard, CLAUDE.md fileOperations §); register any new field typed-array kind in `ATTR_TYPE_MAP` ([fileOperations.ts](../src/model/fileOperations.ts)).

---

## §4 — Simulator interaction

The user's question: *"how would the user brush things, interact with the cells, bonds, and such?"* The shipping interaction layer is **entirely index-keyed** (cell = `row*width+col`) and well-factored: `screenToGrid` pick → geometric brush stamp → rAF-coalesced `paint`/`paintManual` message → worker mutates SoA → re-run color pass. The inspector subscribes a set of `cellIdx` and reads back via `postInspectCellsData`. **For off-lattice + bonds, the ONE load-bearing change is replacing floor-division picking with nearest-agent hit-test; almost everything else reuses because every key is just an array index that re-points cell→agent.** Bonds are the one genuinely net-new surface: a second pick target, three brush modes, a bond inspector sub-table, three worker messages.

### 4.1 The picker seam (the single localized change)

Extract a tiny picker module (the GraphCA §8.1 abstraction):

```ts
interface Picker {
  screenToId(clientX, clientY): number | null;       // → agent id (or cell idx)
  idToScreen(id): { cx, cy, screenRadius } | null;
}
```

Keep the **current** `screenToGrid` ([SimulatorView.tsx:2320-2342](../src/simulator/SimulatorView.tsx)) and `gridToScreen` ([:2348-2360](../src/simulator/SimulatorView.tsx)) as the `2d-grid` impl (`screenToId` = the `idx = row*w+col` it already computes; `idToScreen` returns a square → `screenRadius = cellSize/2`). Add a `center-based` impl whose `screenToId` does a **nearest-agent hit-test**: invert pan/zoom exactly as `screenToGrid` does (the `ox/oy` + `panRef` + `baseScale*zoomRef` math at [:2330-2333](../src/simulator/SimulatorView.tsx)) to get world `(wx,wy)`, then query the **per-step spatial grid the force driver already rebuilds** (CB §6.2 — reuse it, don't build a second index) for the nearest centre within its `screenRadius`. Replace the two raw `idx = row*w+col` derivations (`handleMouseDown`, `handleMouseMove`) + the copy/paste pick with `picker.screenToId(...)`. **This is the only seam** — downstream (inspector, paint, manual brush) is already index-keyed, so cell→agent repointing is essentially free (CB §9 / GraphCA §8.1).

**Perf note (CB §9):** positions must ship worker→main **every frame** for both the renderer AND picking — this disables the WebGPU/OffscreenCanvas direct-render color-skip ([sim.worker.ts:2301](../src/simulator/engine/sim.worker.ts) skips the colors transfer under direct render). The nearest-agent hit-test reuses that already-required positions buffer; don't add a second transfer.

### 4.2 Agent (cell) brush modes

Reuse `flushPaintBatch`'s rAF coalescer ([SimulatorView.tsx:2420-2448](../src/simulator/SimulatorView.tsx)) and `paintAt`'s Bresenham interpolation ([:2454-2516](../src/simulator/SimulatorView.tsx)) **verbatim** — only the cell-collection step changes: instead of `brushCellsAt` stamping `(row,col)` cells, collect **agent ids** under a screen-space radius disc (nearest-set query against `positions`). A `brushTool` enum on the right-panel brush section (mirror the `brushShape` `<button>` strip) selects four tools, each a worker message **keyed by agent id**:

| Tool | Worker message | Worker body |
|---|---|---|
| **Seed/Place** | `createAgent { x, y, attrs }` (continuous world point + the manual-brush attribute snapshot, CB #47/§6.5) | allocate a free-list slot, set `highWater`/`liveAgentCount`; drag scatters along `paintAt`'s Bresenham path |
| **Paint-attribute** | `paintAgents { agentIds, sets:[{attrId,value}], activeViewer }` | `paintManual`'s inner loop ([sim.worker.ts:2620-2640](../src/simulator/engine/sim.worker.ts)) with `idx ← agentId` — the per-attribute set encoding + sub-attr parent-match skip reuse verbatim |
| **Kill** | `killAgents { agentIds }` | the CB free-list death event (recycle slot + break-all-bonds + bump epoch, D8b) |
| **Set-type** | `paintAgents` writing the type tag | special case of Paint-attribute |

**Seeding initial configs (CB §6.7 — a v1 blocker, not a footnote):** the headline demo needs a population before anything runs. Three sources: (a) the **Seed brush** above for single-founder placement; (b) a **`seedAgents`** worker message (place N agents uniformly/Poisson-disc, or lattice-then-perturb, or one-per-image-pixel) applied on Reset via a re-purposed `InitEvent`/`SeedEvent` root exposing the continuous spawn position + per-agent attribute writes; (c) **import a topology** via the `.gcastate` round-trip (§4.5). Bond-on-first-contact vs start-bonded is a model-level seeding flag the worker honors at init (BOND D8c).

### 4.3 Bond brush modes (the net-new surface)

A **second pick target** — a bond, picked as a line segment — plus four modes. Add `pickBondAt(clientX, clientY)`: a distance-from-segment test of the cursor world-point against each rendered bond line (the bond render layer §5.1 draws segments between agent centres) → `{ aId, bId, slot }`. Modes (a tool-strip sibling to §4.2):

| Mode | Gesture | Worker message |
|---|---|---|
| **Glue (drag-to-connect)** ★ most natural | LMB-press on nearest agent A (`screenToId`) → rubber-band line to the cursor (reuse the Line-tool staged-anchor pattern, `lineAnchorRef` + `draw()`) → release on agent B | `formBond { aId, bId, typeLabel }` |
| **Cut a bond** | click a bond segment (`pickBondAt`) | `breakBond { aId, bId }` |
| **Region-glue** | over a lasso/box selection (`selectedAgents`, §4.6) | `formBondsRegion { agentIds, typeLabel, maxDist }` — glue every within-`maxDist` pair |
| **Region-cut** | over the selection | `breakBondsRegion { agentIds }` |

All bond messages resolve through the resolve→guard→write-bond-buffer shape ([MoveSelfToNeighborNode.ts:70-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts)) and mutate the persistent ragged bond store in the **post-step structural phase** (BOND D2) so they're visible next step. Each posts back through the same `sendColors`/refresh tail so the bond render updates immediately.

**Guardrails the brush cannot violate (BOND §9.1):** region-glue must respect the `maxBonds` ceiling and **reject + surface on overflow, never wrap** (the Amphiphile-NI-poisoning class — surface a worker error like the WebGPU paint handlers do, [sim.worker.ts:2567](../src/simulator/engine/sim.worker.ts)); the Kill brush must break-all-bonds + bump the slot epoch (D8b — else a recycled slot inherits stale bonds pointing at a stranger); manual glue intentionally **bypasses** the form/break hysteresis (that anti-flicker only governs the *automatic* rules, D5).

### 4.4 The agent + bond inspector

Extend `postInspectCellsData` ([sim.worker.ts:2214-2247](../src/simulator/engine/sim.worker.ts)) to also emit, per inspected agent id: its bond list `[{ partnerId, restLength L, currentLength l, stiffness λ, typeLabel, strain = λ(l−L) }]` + position `(x,y[,z])` + radius + lineage/cycle (CB #35). In `InspectCellPopover.tsx` add a **BONDS section** below the existing attribute table: one row per bond `[partner id/type][rest→current length][strain bar]`, each row clickable to (i) inspect the partner (`commitInspectPopover` with `partnerId` as the key, [SimulatorView.tsx:2297-2316](../src/simulator/SimulatorView.tsx)) or (ii) cut the bond (`breakBond`). A separate bond-popover variant (picked via `pickBondAt`) shows the single bond `{ aId, bId, L, l, λ, type, strain }` with a Cut button, the leader anchoring to the segment midpoint instead of a cell rect.

### 4.5 What reuses from today's infra (the reuse ledger)

The interaction protocol is already index-keyed, so these carry over **unchanged**: (1) the rAF paint coalescer `pendingPaintCells`/`flushPaintBatch` (push agent/bond ids instead of cells); (2) the `data-sim-overlay` mousedown gate ([SimulatorView.tsx:2655](../src/simulator/SimulatorView.tsx)) + all overlay bars; (3) zoom/pan (`zoomRef`/`panRef`, wheel + RMB-drag — only the world→screen constants change, CB §9); (4) the inspector subscription + `inspectCellsData` after-every-step readback (agent id replaces cellIdx); (5) `ManualBrushPanel`'s per-attribute widgets ([ManualBrushPanel.tsx:35-99](../src/simulator/ManualBrushPanel.tsx)) — reused verbatim for Paint-attribute + Seed-attrs, incl. the neighborIndex grid; (6) the `getState`/`loadState`/`.gcastate` save shape — **extended** with the ragged bond layer over the free-list (base64 typed arrays + partner-id remap on compaction + load validation, BOND D8); (7) `encodeAttrValue` (used at [flushPaintBatch:2440](../src/simulator/SimulatorView.tsx)) — reused by `paintAgents`/`createAgent` to encode attribute values. **Gated off (lattice-only, CB §9):** the geometric brush stamp (`brushShapeOffsets`/`lineStampCells`/Bresenham/silhouette, [:50-134](../src/simulator/SimulatorView.tsx)), gridlines, infinity-tiling, image-import (1px=1cell) — but the rAF coalescer that wraps them is kept.

### 4.6 Agent selection + lasso (drives region modes)

A runtime-only `selectedAgents: Set<number>` ref, painted as a highlight ring. Plain LMB-click = select nearest (when a SELECT tool is active); Shift = add; Ctrl = remove (mirror the modeler's box-select modifiers, CLAUDE.md "Group box-select modifiers"). LASSO = a freehand polygon captured on LMB-drag in screen space, point-in-polygon each agent's `idToScreen` centre on mouseup. Selection drives region-glue/cut (§4.3).

**New `WorkerMsg` union additions (per CLAUDE.md):** `createAgent`, `paintAgents`, `killAgents`, `formBond`, `breakBond`, `formBondsRegion`, `breakBondsRegion`, `paintField`, `seedAgents` — each requires extending the `WorkerMsg` union in [sim.worker.ts](../src/simulator/engine/sim.worker.ts).

---

## §5 — 3D visualization & navigation

The user's question: *"how to visualize in 3D, navigate and all that?"* The entire render pipeline funnels through ONE function, `draw()` ([SimulatorView.tsx:743](../src/simulator/SimulatorView.tsx)), whose hot path is "fill an H×W `colors` buffer into an off-screen `srcCanvas` via `putImageData`, then `drawImage` it under a zoom/pan transform" — a dense **lattice blit**. The plan: a 2D entity renderer first (a localized swap behind the same seam), then a **wholesale new WebGL renderer** for 3D — honest that the latter has no lattice precedent, but proven possible by the WebGPU OffscreenCanvas seam.

### 5.1 The 2D entity renderer first (localized swap)

Branch `draw()` on substrate, not a rewrite: after the early-returns at [SimulatorView.tsx:743](../src/simulator/SimulatorView.tsx), add `if (centerBased.enabled) return drawAgents();` (the GraphCA §8.1 "branch to a sibling `drawGraph()`" pattern). `drawAgents()`:

- **Reuses** the transform block **verbatim** ([:795-802](../src/simulator/SimulatorView.tsx): `baseScale`/`scale`/`ox`/`oy` from `zoomRef`/`panRef`) — but treats them as a world→screen map over `centerBased.worldBounds` instead of a w×h grid.
- Does **NOT** build `ImageData`; iterates live agents (0..highWater, **skip `!alive`** — the free-list has holes, CB §6.6) and draws a filled circle: `cx = ox + agentX[i]*scale; cy = oy + agentY[i]*scale; r = agentRadius[i]*scale`, colour read from the **SAME `colorsRef` buffer slot** `colors[i*4..i*4+3]` (reuse the index-keyed contract at [SimulatorView.tsx:1196](../src/simulator/SimulatorView.tsx) — **zero worker change for colour**).
- **Bonds draw FIRST** (under agents) as batched line segments: for each bond k of agent i, `ctx.moveTo(...); ctx.lineTo(ox+agentX[partner]*scale, ...)` in one `ctx.beginPath()/stroke()` — the gridlines batched-stroke at [:934-963](../src/simulator/SimulatorView.tsx) is the exact template (BOND D10).
- **Gates off:** infinity tiling, gridlines, glyph overlay, the brush silhouette cursor (replace with a nearest-agent hover ring).

**Per-agent colour is pure node-graph authoring** — the user authors the Attribute→Color Output Mapping exactly as today (Color Scale / categoricalColor over `type`/`age`/`curvature`/`bondDegree`/a sampled field), and it compiles to the same index-keyed `colors` buffer. **But** the *compiled* Output-Mapping color pass that FILLS the buffer bakes lattice geometry (`colorIdx = idx*4` over `total`, [compile.ts:1748-1752](../src/modeler/vpl/compiler/compile.ts)) and needs the same agent-iteration rework as the Step body (CB #30a) — "zero change" is true of the *buffer*, not the *pass that writes it*.

**Positions are a new first-class render input** the lattice never needed (a cell's position is implicit in its index): `agentX/agentY[/agentZ]` + `agentRadius` + `aliveMask` + `highWater` + the bond CSR (`partnerIdx[]` + per-agent start/len) ship in the `stepped` message alongside `colors` (extend [sim.worker.ts:2313-2320](../src/simulator/engine/sim.worker.ts)'s transfer list). Cap the naive Canvas2D `drawAgents()` loop to the JS "Debug/Reference" tier (a few thousand agents); route large-N to the instanced GPU path (§5.2).

### 5.2 The 3D renderer (WebGL2 — honestly, wholesale new)

**Be honest: 3D is a from-scratch new renderer, not a config flip on the lattice blit** (CB §9 line 383 / CPM §9 — "3D is easy is true of the engine, the force law gains a z; NOT the renderer"). Zero WebGL/Three.js exists today; the visible `canvasRef` is hard-wired to a `'2d'` context ([SimulatorView.tsx:754](../src/simulator/SimulatorView.tsx)) and the 2D overlay compositing (brush cursor, gridlines, inspector ring) depends on it — you **cannot** `getContext('webgl2')` on it. Instead **mirror the WebGPU OffscreenCanvas architecture** ([webgpuRuntime.ts:502-540](../src/simulator/engine/webgpuRuntime.ts) — `setupDirectRender` does `getContext('webgpu')` + `configure` + a `presentColors` pipeline, and `draw()` composites it via `drawImage` at the `directRenderActiveRef` seam, [SimulatorView.tsx:771/906-925](../src/simulator/SimulatorView.tsx)): create a **second canvas** (a worker-owned OffscreenCanvas to match the direct-render seam, or a main-thread one for v1 simplicity), get a `'webgl2'` context on **it**, render the 3D scene there, and have `draw()` composite it via `ctx.drawImage(gl3dCanvas, 0, 0)`. This keeps the 2D overlay compositing on the visible canvas unchanged.

**Spheres = ONE instanced draw call** (the Simularium / molecular-viewer technique, Lyons et al. Nature Methods 2022): a unit-sphere or **billboard impostor** VBO + a per-agent instance buffer of `{ x, y, z, radius, rgba-from-colorsRef }`. **Impostor spheres** (a screen-facing quad with an analytic ray-sphere in the fragment shader writing `gl_FragDepth`) are the standard 10⁴–10⁵ path — cheaper than tessellated spheres and pixel-perfect, and `gl_FragDepth` is **mandatory** for correct inter-sphere occlusion (a flat billboard sorts by quad centre → wrong occlusion at overlapping/dividing daughters, the densest moment in a morphogenesis run). Reuse the `colorsRef` index-keyed contract for instance colour (zero worker change). Grow the instance buffer in fixed chunks (Simularium grows 256 at a time, deck.gl chunks to beat Chrome's ~1 GB single-allocation cap) — at 10⁴–10⁵ bonded agents this is comfortable headroom (deck.gl: 60 fps to ~1M instanced points).

**Small-N software-3D fallback** (the JS/Debug tier + WebGL-unavailable browsers): a Canvas2D painter's-algorithm path inside `drawAgents()` — project each agent through the orbit camera, depth-SORT back-to-front, draw filled circles with a radial gradient (fake shading) + depth-cued darkening, bonds as depth-sorted segments. No GL context, correct for a few hundred agents — the 3D analogue of the 2D `drawAgents()`.

### 5.3 Navigation — orbit camera (all new)

The 2D `zoomRef`/`panRef` don't generalize to 3D. Add a `cameraRef` holding `{ target: vec3, distance, yaw, pitch }` (orbit), replacing zoom/pan when `centerBased.dimensions === 3`:
- **Drag-rotate** (LMB-drag → yaw/pitch deltas), **scroll-zoom** (wheel → distance, the cursor-anchored wheel handler is the input template), **MMB/Shift-drag → pan target**. Build view+projection matrices each frame (a tiny inline mat4 for v1, or pull `gl-matrix`). Default to **OrbitControls semantics** (fixed up-vector, no pole flip — the best tissue default; Trackball/Arcball as alternates).
- **Depth cueing:** fog/darken by camera-space depth in the impostor fragment shader (and the software fallback) — the biggest interior-legibility win for dense tissue.
- **Clipping / slicing to see inside:** a user-movable clip plane — `if (dot(worldPos, planeN) > planeD) discard;` in the fragment shader — plus a "slab" two-plane cross-section mode. Surface the clip-plane position as a **bounded model attribute** (reuse the slider machinery, §3.2) so "reveal interior" is authorable + live-tunable.
- The transport-bar fullscreen + the `genesis-toggle-canvas-fullscreen` event (CLAUDE.md) carry over unchanged.

### 5.4 3D picking — GPU colour-id

Recommend **GPU colour-id picking** over CPU raycast for the instanced path (raycasting 10⁵ spheres per click is too slow and re-implements the broad-phase). Render a SECOND off-screen pass where each agent's instance colour = its `agentId` encoded as RGB (`r=id&0xff, g=(id>>8)&0xff, b=(id>>16)&0xff` — the categoricalColor encode shape, ~16.7M ids; deck.gl), `gl.readPixels` the pixel under the cursor, decode → `agentId`. This reuses the SAME instanced geometry + instance buffer (different colour attribute, no lighting), is **depth-correct for free** (the nearest sphere wins the depth test — which is why impostor `gl_FragDepth` matters here too), and repoints the result through `screenToId`'s downstream (inspector/glue-cut) identically to 2D. CPU raycast is the fallback for the software-3D path (small N).

### 5.5 Bonds in 3D + LOD

Bonds are batched line segments in 2D, but in 3D **thin GL lines alias badly and ignore depth occlusion by spheres** (they'd render ON TOP of spheres that should occlude them). Recommend **instanced tubes** (oriented quad-strips or billboarded cylinders) that write `gl_FragDepth` and depth-test against the sphere buffer — depth-sorting falls out of the shared depth buffer. **LOD is mandatory** (the edges-are-the-cost-bottleneck finding, GraphCA §8.4): below a screen-space bond-length threshold draw lines not tubes; tighter still, hide bonds; **frustum-cull** agents+bonds outside the view from the instance buffers each frame. **Recording/screenshot** must move from the grid-resolution `ImageData` capture ([:1318-1331](../src/simulator/SimulatorView.tsx)) to **display-canvas capture** (no w×h source bitmap exists off-lattice — the screenshot-from-display path at [:3244-3261](../src/simulator/SimulatorView.tsx) is the template); the bond + 3D layers must be captured so "what you see is what you record" holds (BOND D8f). **Re-frame perf guard:** `draw()` runs from rAF on the play hot path and re-assigning `canvas.width` is "the dominant per-frame cost" ([:759-764](../src/simulator/SimulatorView.tsx)) — the instanced path must reuse persistent GL buffers (orphan-and-reupload the instance buffer, don't recreate the context/program per frame).

---

## §6 — Data model & engine (concise; references the investigations)

The substrate is fully specified in CB §5-§7 and BOND §5; this is a one-screen recap of what is allocated and what is reused. **All of it is unbuilt today** — there is zero agent/bond/free-list code in `src/`.

**The agent SoA tier** (CB §5.1): an additive `centerBased?: CenterBasedConfig` sub-object on `CAModel` (template: [VariegatedCellsConfig, types.ts:470-483](../src/model/types.ts)) holding `{ enabled, maxCells, dimensions: 2|3, worldBounds, perAgentAttributes, forceLaw refs, seeding }`, plus worker-side **parallel SoA typed arrays of length `maxCells`** (`Float64Array` for `x`/`y`/`z`/radius/cycle, `Int32Array` for lineage/type) + a **free-list** for slot recycling. Continuous positions are pure-float → `float64` already round-trips ([fileOperations.ts:383-386](../src/model/fileOperations.ts)). `maxCells` is an **over-allocated ceiling** (allocate-once at init, [initGrid:750](../src/simulator/engine/sim.worker.ts)); overflow **rejects + surfaces**, never wraps (CB §5.1, the Amphiphile-NI-poisoning class). From the WASM phase the arrays are baked into a `wasmMemory` region under the copy-into-never-reassign view discipline.

**The bond ragged store** (BOND §5.1, D1): a per-agent fixed-capacity array (`maxBonds` slots) `{ partnerId, partnerEpoch, restLength L, stiffness λ, typeLabel, age/strength }`, SoA over `wasmMemory`. **Persistent across steps** (NOT the CB distance list, which is recomputed). Mutated only in the post-step structural phase (D2, single store, sync-only v1). The **dangling-bond ABI** (D8b): `partnerEpoch` slot-generation tag checked on every read + "break all bonds on death" + a per-step stale-partner sweep. `maxBonds` overflow rejects + surfaces (D4).

**The field grid** (§3.1): one `Float64Array` per substrate, length `fieldW*fieldH`, double-buffered, with its own fixed-stride neighbour table — a separate iteration domain from agents.

**The driver loop** (CB §6.1): per generation — (1) rebuild the spatial neighbour grid from current positions (alive-mask, not a dense `0..liveAgentCount`); (2) force pass (the compiled `behaviourStep` over `aIdx`, summing the soft-sphere repulsion **and** the bond springs, BOND §5.3); (3) commit positions (double-buffer swap, the sync ref-swap idiom at [sim.worker.ts:1233-1235](../src/simulator/engine/sim.worker.ts)); (4) post-step structural phase — advance cycle, grow radius, apply `_divideRequest`/`_killRequest`/`_bondFormReq`, eigensolve axes, partition bonds, K-substep field diffusion. `Δt` is auto-clamped against `Δt*_mono = ½(r₀−s)/F(r₀)` accounting for bond `λ` (CB §6.3, BOND §5.3).

**Reused:** the SoA discipline + `createTypedArray`; the worker message protocol; the single sequential xorshift32 RNG (a sequential stream maps onto the sequential per-agent loop); `cachedModelAttrs`/`syncModelAttrsToMemory` for force-law params; the `lookupTable` adhesion/spring matrix (live-tunable, two channels); the indicator reduction *pattern* (re-point the bound to `0..highWater` + alive-mask, CB §6.6); accessor-CSE (sync mode here, so valid). **Gated off:** `orderArray` (center-based is sync, not async); the lattice geometry; the variegated/orientation subsystem (square-lattice-only); spatial rows/columns indicators.

---

## §7 — Subsystem impact map

Legend: ✅ reuse · ✏️ modify · ➕ new · 🚫 gate off · ⚠️ silent-corruption hazard. **This lists the bond/division/field/interaction/render DELTA grounded in the codebase audit** — the full CB substrate Impact Map (50 rows: agent tier, force driver, free-list, neighbour rebuild, renderer) is the prerequisite and is not relisted (CB §11).

### Rule authoring (compiler + nodes)
| Subsystem | File / symbol | Change | Note |
|---|---|---|---|
| `behaviourStep`/`divisionEvent`/`bondContactEvent`/`fieldStep` event roots | new node files; compile via [compile.ts:1857-1899](../src/modeler/vpl/compiler/compile.ts) InitEvent template | ➕ | agent roots loop `aIdx<highWater` (fork the [compile.ts:1748-1752](../src/modeler/vpl/compiler/compile.ts) preamble); fieldStep keeps lattice preamble |
| `divideCell`/`killCell`/`formBond`/`breakBond`/`setTargetRadius`/`secreteToField` flow nodes | new files; emit shape = [SetAttributeNode.ts:15-20](../src/modeler/vpl/nodes/SetAttributeNode.ts) / [MoveSelfToNeighborNode.ts:64-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts) | ➕ | emit requests into engine buffers; **NOT** async-only (BOND §5.2) |
| `GetBondDegree`/`SummedBondStrength`/`NeighbourDensity`/`GetCurvature`/`SampleField`/`FieldGradient`/`GetSelfPosition`/`GetBondedNeighbourAttr`/`GetRadius` read nodes | new files; shape = [GetCellAttributeNode.ts:13-17](../src/modeler/vpl/nodes/GetCellAttributeNode.ts) | ➕ | first-class, NOT Average-macros (D13); `varName()` reg for multi-output |
| `ForEachBond` (ragged bond iteration) | clone [ForEachInArrayNode.ts:3-21](../src/modeler/vpl/nodes/ForEachInArrayNode.ts); dispatch at [compile.ts:961-977](../src/modeler/vpl/compiler/compile.ts) | ➕ | adds an iteration source, not a new emit kind (BOND §5.3) |
| `buildLoopParams` agent/bond/field param append | [compile.ts:1132-1162](../src/modeler/vpl/compiler/compile.ts) (clone the gate at :1156) | ✏️ | gated on `model.centerBased?.enabled`/`bondGraph?.enabled` |
| `readAttrExpr` read chokepoint | [types.ts:47-62](../src/modeler/vpl/types.ts), [compile.ts:391-416](../src/modeler/vpl/compiler/compile.ts) | ✅ | works with `aIdx`; do NOT invoke NI codec/sub-attr guard from agent nodes |
| Vector force reduction `Σ F(d)·r̂` + `GetNeighborPosition` | new emit, 3 compilers | ➕ | the CB doc's genuinely-new emit (CB #24a); bonds reuse it (D6) |

### Mode wiring & schema
| Subsystem | File / symbol | Change | Note |
|---|---|---|---|
| `bondGraph?`/`centerBased?`/`fieldEnvironment?` sub-objects | [types.ts:470-483,521-540](../src/model/types.ts) (clone VariegatedCellsConfig) | ➕ | additive; old files load unchanged |
| `UPDATE_BOND_GRAPH`/`*_BOND_CLASS` reducers + cascade + default-fill | [ModelContext.tsx:892-978](../src/model/ModelContext.tsx) (clone `UPDATE_VARIEGATED_CELLS`); cascade clone [:260-262,947-957](../src/model/ModelContext.tsx) | ➕ | dispatchers into both useMemo dep arrays [:1311-1358](../src/model/ModelContext.tsx) |
| Bond-class palette (type-pair adhesion classes) | clone [FaceLabelPalette, types.ts:444-451](../src/model/types.ts) | ➕ | structural reuse (D23) |
| `requirements.bondGraph?`/`centerBased?`/`lattice?` capability flags | [vpl/types.ts:76-81](../src/modeler/vpl/types.ts); branches in [nodeValidation.ts:440-464](../src/modeler/vpl/nodes/nodeValidation.ts) | ✏️ | near-mechanical clone of `variegated?` (D24) |
| `detectMissingConfig` cases (divideCell/formBond/SampleField/…) | [nodeValidation.ts:61](../src/modeler/vpl/nodes/nodeValidation.ts) (no default case) | ➕ ⚠️ | every required-config node MUST add a case or compiler emits `_undef` |
| Master toggle + `B` ActivityBar tab + ModelerView auto-switch | [PropertiesPanelContent.tsx:288-304](../src/modeler/panels/PropertiesPanelContent.tsx), [ActivityBar.tsx:5,47-49](../src/modeler/ActivityBar.tsx), [ModelerView.tsx:86-87](../src/modeler/ModelerView.tsx) | ✏️ | both tab halves land together; clone variegated wiring |
| `BondGraphPanelContent` (maxBonds + bond classes + spring matrix + division/field params) | new file; clone [VariegatedCellsPanelContent.tsx](../src/modeler/panels/VariegatedCellsPanelContent.tsx) | ➕ | NumberField for maxBonds (CLAUDE.md); embed `LookupTableEditor` for the spring matrix |

### Engine, bonds, division, field
| Subsystem | File / symbol | Change | Note |
|---|---|---|---|
| Persistent ragged bond store (`maxBonds` SoA over wasmMemory) | new worker tier, sibling to agent SoA ([initGrid:750](../src/simulator/engine/sim.worker.ts)) | ➕ | D1; persists across steps |
| Post-step structural bond mutation (single store, sync-only v1) | force driver (extends CB §6.1) | ➕ | D2; real write-buffer only for future async (D11 🚫) |
| `maxBonds` overflow rejection + dangling-bond ABI (`partnerEpoch` + break-on-death + stale sweep) | bond store + death event | ➕ ⚠️ | D4/D8b — recycled slot re-points a spring to a stranger |
| Hysteresis (`d_form < d_break`) | force/structural pass | ➕ ⚠️ | D5 — equal thresholds flicker every step |
| Division-axis eigensolve + geometric reattachment | extends CB §6.4 `divide()` | ➕ ⚠️ | D12/D14 — the riskiest piece (maxBonds + epoch + Δt overshoot at once, BOND §3.4) |
| Bond spring matrix (`λ`,`L` per type-pair) | existing `lookupTable` (2-channel) | ✅ | D9 — no new attribute type |
| Bond serialization + load validation (ragged + free-list + remap) | extends CB #41 (`SimulationState` agent table) | ✏️ ⚠️ | D8 — reject loudly; register non-float kinds in `ATTR_TYPE_MAP` |
| Field SoA + diffusion (Gray-Scott graph) + `SecreteToField`/`SampleField` | reuses [gen-grayscott.mjs:100-168](../scripts/gen-grayscott.mjs) | ✅/➕ | D17-D18 — bilinear sample is the only new emit (§3.1) |
| `GetCurvature` + bent-beam strain + hysteretic-actuator macro + (γ,χ) slider | new files + Local-Variable pattern | ➕ ⚠️ | D19-D21 — symmetric feedback just flattens (BOND §6.3) |
| Global env model-attrs + live `updateModelAttrs` sync | [GetModelAttributeNode.ts:27](../src/modeler/vpl/nodes/GetModelAttributeNode.ts), [sim.worker.ts:3008-3019](../src/simulator/engine/sim.worker.ts) | ✅ | zero new code (§3.2) |

### Simulator interaction & rendering
| Subsystem | File / symbol | Change | Note |
|---|---|---|---|
| Picker seam (`screenToId`/`idToScreen`) → nearest-agent | [screenToGrid/gridToScreen:2320-2360](../src/simulator/SimulatorView.tsx) | ✏️/➕ | the ONE load-bearing pick change (§4.1) |
| Agent brush: `createAgent`/`paintAgents`/`killAgents` worker messages | clone `paintManual` inner loop [sim.worker.ts:2620-2640](../src/simulator/engine/sim.worker.ts); coalescer [SimulatorView.tsx:2420-2516](../src/simulator/SimulatorView.tsx) | ➕ | reuse rAF batch + `encodeAttrValue` |
| Bond brush: `formBond`/`breakBond`/`formBondsRegion`/`breakBondsRegion` + `pickBondAt` | new messages + segment hit-test | ➕ ⚠️ | region-glue rejects on `maxBonds` overflow (BOND §9.1) |
| `paintField` (paint into the field) | clone `paintManual`/`writeRegion` mask loop [sim.worker.ts:3327-3354](../src/simulator/engine/sim.worker.ts) | ➕ | source/sink/wound (§3.3) |
| Agent + bond inspector | extend `postInspectCellsData` [sim.worker.ts:2214-2247](../src/simulator/engine/sim.worker.ts) + `InspectCellPopover.tsx` | ✏️/➕ | bond sub-table + per-bond strain (D8e/§4.4) |
| `seedAgents` + Seed brush (initial config) | new message + brush mode | ➕ | v1 blocker — no lattice to randomize (CB §6.7) |
| `drawAgents()` 2D entity renderer (circles + bond segments) | branch [draw():743](../src/simulator/SimulatorView.tsx); batched stroke [:934-963](../src/simulator/SimulatorView.tsx) | ➕ | reuses transform + index-keyed colors (D10/CB #27) |
| Positions+bonds shipped worker→main every frame | extend stepped msg [sim.worker.ts:2313-2320](../src/simulator/engine/sim.worker.ts) | ➕ | disables direct-render color-skip (CB §9) |
| Index-keyed `colors` buffer→pixels render contract | [SimulatorView.tsx:1196](../src/simulator/SimulatorView.tsx) | ✅ | per-agent colour = buffer slot i |
| WebGL2 instanced spheres + bond tubes + orbit + GPU-id pick + clip plane | new renderer behind the [webgpuRuntime.ts:502](../src/simulator/engine/webgpuRuntime.ts) OffscreenCanvas seam | ➕ | wholesale new (CB #37 / §5.2) |
| Recording/screenshot → display-canvas capture | [SimulatorView.tsx:1318-1331,3244-3261](../src/simulator/SimulatorView.tsx) | ✏️ | no w×h bitmap off-lattice (BOND D8f) |

---

## §8 — Phased implementation plan

Each milestone has a **visible demo** and maps to the new nodes + Impact rows. Sequencing: build the CB substrate (M1) first, then layer the bond/division/field/render delta. Cross-target lockstep noted per milestone (JS-first prototyping → WASM → WebGPU port, per [feedback_compiler_lockstep]).

### M0 — decisions (BOND §9.2, CB §13.2)
Confirm: (A) center-based + bonds over (B) vertex; bonds **sync-only v1**; `maxBonds` ceiling + **reject-on-overflow**; geometry-driven (not free) bond partition; hysteresis mandatory; the engine-agnostic-IR commitment; division axis = **tension proxy** (label honestly, no "shape long-axis"); v1 = tiers I-III (no field), v2 = field + curvature.

### M1 — agent + force + 2D render (the CB substrate)
**Build:** CB Phases 0-2 — `centerBased` config + per-agent SoA + free-list; the force-integration driver (overdamped forward Euler + position double-buffer + the `Δt` monotonicity guard from the start); a uniform-grid per-step neighbour rebuild; an authorable repulsion+adhesion force graph; the `behaviourStep` root; `drawAgents()` circle renderer + nearest-agent picker + `seedAgents`. JS only.
**Demo:** soft spheres seeded in a blob push apart and relax into a packing; you can pan/zoom/seed/pick. ➕ rows: CB #1-#12, #27-#29, #49; the `behaviourStep` root + `GetSelfPosition`/`GetNeighborPosition`/`GetRadius` + the force-law node + the vector reduction (CB #24a).
**Lockstep:** WASM port of the driver+force kernel as M1.5 (baked `wasmMemory`); WebGPU deferred to M6.

### M2 — bonds + glue/cut brush
**Build:** the persistent ragged bond store (D1) + post-step structural mutation (D2) + the dangling-bond ABI (D8b); initial-bond seeding (D8c); the bond-spring matrix via `lookupTable` (D9); `FormBond`/`BreakBond` nodes (D3) with `maxBonds` rejection (D4) + hysteresis (D5); per-bond force in the vector reduction (D6-D7); the bond render layer (D10) + the glue/cut/region brush + bond inspector sub-table (D8e/§4.3-§4.4) + bond-graph indicators (D8d); the `bondContactEvent` root + `GetBondDegree`/`SummedBondStrength` + `ForEachBond`.
**Demo:** a 2D aggregate **glues into chains and clusters**; differential adhesion sorts and bonds lock the sorted state (visibly distinct from M1's gas-of-spheres); you can drag-to-connect and cut bonds by brush.
**Lockstep:** WASM bond-list iteration emit alongside JS.

### M3 ★ — division rules + the rule editor (the centrepiece)
**Build:** the **tension-proxy** division-axis eigensolve + degenerate fallback (D12); `GetBondDegree`/`NeighbourDensity`/`SummedBondStrength` reads (D13); geometric bond reattachment (D14) with the post-division `Δt`+`maxBonds` guard (BOND §3.4); the `divideCell` flow node + the `divisionEvent` root (daughter assignment, §2.2) + `setTargetRadius` growth + `killCell` death; tension-vs-density-gap weighting slider (D15). The division-rule editor surfaces the `axisSource` dropdown + the optional axis override + the daughter `divisionEvent` graph.
**Demo:** a glued cluster **grows and divides along its tension axis, bonds inherited by geometry** — the tissue elongates along a mechanical axis instead of ballooning; the user authors "divide when age>T and size>X, give daughter A more of Q" entirely as node graphs (worked example A, §2.2). *Tiers I-III, no field — the minimal v1 differentiator.*
**Lockstep:** the eigensolve is engine-owned (worker), so no per-target emit; `divideCell`/read nodes lockstep across JS/WASM.

### M4 — field + environment + chemotaxis
**Build:** the field SoA + `fieldStep` diffusion root (Gray-Scott graph, D18); `SampleField`/`FieldGradient`/`SecreteToField` (D17, the bilinear emit on all 3 targets); the two branching presets (chemoattract/chemorepel); the `paintField` brush (source/sink/wound, §3.3); global env attrs documented + seeded.
**Demo:** the v1 aggregate now **branches under a chemotactic field** (worked example, §3.5 — nutrient-limited growth + chemotaxis); painting a chemoattractant source / nutrient sink / wound perturbs it live. *v2 autonomy headline.*
**Lockstep:** the field reuses Gray-Scott (already 3-target); SampleField bilinear is the one new emit to lockstep.

### M5 — curvature / branching autonomy
**Build:** `GetCurvature` (lateral + topographical) + bent-beam strain node (D19); the fast-sensor/slow-actuator **hysteresis macro** (D20, Local-Variable pattern — the time-lag is mandatory or it flattens and stalls); the (γ,χ) morphology slider (D21).
**Demo:** repetitive branching/tubulation that **re-fires from passive curvature propagation** (the Vikran/Hirashima loop) — bending the tip moves cells, flank curvature rises next step, the cycle restarts with no special rule.
**Lockstep:** curvature is engine-computed; the strain node + macro lockstep.

### M6 — WebGL 3D + orbit (+ WebGPU)
**Build:** the wholesale new WebGL2 instanced-sphere + bond-tube renderer behind the `draw()`/`srcCanvasRef` seam (§5.2); the orbit camera + depth cueing + clip-plane slicing (§5.3); GPU colour-id picking (§5.4); LOD + frustum culling (§5.5); the software-3D fallback; recording/screenshot → display-canvas capture. **WebGPU force kernel** (the strong GPU fit, hash→sort→offset→gather, worker-side division/compaction) lands here too.
**Demo:** the whole morphogenesis run **in 3D** — orbit around a growing bonded tissue, slice into it to see the interior, pick a cell to inspect. 3D is a dimensionality switch for the engine (force/axis/bonds gain a z) + a from-scratch renderer.
**Lockstep:** WebGPU is the third compile target for the force/behaviour/field roots; the three-target lockstep rule applies as the wave lands.

**Validation is statistical, not bit-exact** (WGSL f32 + per-cell PCG preclude parity): sorting/cluster metrics, division-axis alignment vs the tension field, branch count/spacing vs the (γ,χ) regime, Okuda/Nelson canonical morphologies as built-in examples.

**Sample models (per the gen-*.mjs pattern):** `scripts/gen-adhesion-sorting.mjs` (M2 demo — clone [gen-amphiphile.mjs:90-166](../scripts/gen-amphiphile.mjs) helpers + the preserve-simulationState+thumbnail re-run tail) and `scripts/gen-branching.mjs` (M4 demo). Both auto-index via `modelsLibraryPlugin` (CLAUDE.md vite gotcha: restart the dev server to pick up new `public/models/`).

---

## §9 — Risks & open decisions

### 9.1 Silent-corruption hazards (decide up front — they fail quietly)
1. **The division reattachment triple-hazard (riskiest, BOND §3.4/D14).** Division mutates partners' bond lists + creates the daughter-daughter bond + seeds overlapping daughters — hitting `maxBonds` overflow, the stale-partner/epoch invariants, and the post-division `Δt` overshoot **simultaneously**. Mitigation: mutate in the post-step structural phase only; on `maxBonds` overflow during reattach **reject the whole division** (never leave a partner half-rewired); clamp `Δt ≤ Δt*_mono` against the combined worst case; serialize the case where a partner is **also** dividing this step.
2. **Dangling-bond / free-list ABI (D8b).** A recycled dead slot silently re-points a spring to a stranger → `partnerEpoch` slot-generation tag + break-bonds-on-death + a per-step stale sweep.
3. **`maxBonds` / `maxCells` overflow must reject + surface, never wrap** (D4) — the Amphiphile-NI-poisoning class. Surface via the Stop-Event/blue-notice channel.
4. **`Δt` monotonicity** (CB §13.1 #2) — a "stable" but too-large `Δt` after division silently corrupts geometry (drift, not crash). The default *is* the guard: `Δt ← min(Δt_user, 0.4·Δt*_mono)`, re-evaluated on any force/bond-`λ` parameter change.
5. **Hysteresis mandatory** (D5) — equal form/break thresholds flicker every step.
6. **Curvature feedback must be asymmetric/hysteretic** (D20) — a symmetric negative-feedback loop just flattens and stalls; the slow-actuator time-lag is what makes it repeat (the single easiest-to-miss subtlety, Vikran/Hirashima).
7. **First-class density/degree/curvature nodes, NOT Average-macros** (D13) — `Average` equals density only if the array length equals the degree; a degree-tolerant first-class node is required. `detectMissingConfig` has no default case ([nodeValidation.ts:61](../src/modeler/vpl/nodes/nodeValidation.ts)) — every new required-config node needs a case or the compiler emits `_undef`.
8. **`.gcastate` / field-length validation must fail loudly** — no try/catch around deserialize → a throw aborts the whole load silently ("click load, nothing happens"). Register any non-float agent/bond/field array kind in `ATTR_TYPE_MAP` at the same commit (CB §13.1 #3-#4).
9. **Neighbour-scratch overflow under compression** (CB §13.1 #7) — OS cells gain more neighbours when a cluster packs tight; a fixed compile-time `maxDegree` can overflow silently at the high-density moment. Size generously + a runtime clamp/warning.
10. **Both ActivityBar tab halves land together** (the gated tab + the ModelerView auto-switch) or the user gets stranded on a tabless panel.

### 9.2 Open decisions for the user
- **Substrate (the headline).** Confirm (A) center-based + bonds first (recommended — fits the IR, GPU-native, 3D-clean, delivers aggregates/chains/clusters/branching, but **no true cell shape** and **only the tension axis, not the faithful Hertwig shape long-axis**) vs scoping (B) vertex as a deliberate second engine sooner *if faithful geometric long-axis division is non-negotiable* (BOND §2/§9.2). Recommendation: (A) first.
- **Field tier scope.** Confirm v1 = the glued-divide demo (tiers I-III, no field); v2 = field + autonomous branching (BOND §8). v1 stands alone, so the commitment needn't bundle the field.
- **Curvature scope.** Full sense→act→re-sense hysteresis loop (the autonomy generator, hardest to author) vs curvature-as-a-read-only-input first.
- **Bond mutation under async.** Confirm sync-only v1; async mutable topology (conflict semantics) is a later decision (D11).
- **The engine-agnostic IR commitment** — the prerequisite for ever adding (B) vertex, and already non-trivial (the CB audit proved the current IR bakes lattice geometry).

### 9.3 What the literature flags
- **3D-in-browser at scale (Simularium / deck.gl / MorphoNet).** The Simularium viewer (Lyons et al., Nature Methods 2022) is the reference: three.js + GPU sphere impostors + instanced buffers + free GPU-id picking from a GBuffer — 10⁴–10⁵ cells comfortable (deck.gl: 60 fps to ~1M instanced points, crash 10M-100M at Chrome's ~1 GB single-allocation cap → chunk). **PhysiCell has NO in-browser 3D viewer** (3D is offline via POV-Ray/ParaView) — the gap GenesisCA fills, but also: there is **no reference web center-based engine to copy** (CB §2.6), so the risk is engineering, not research. MorphoNet's mesh-per-cell (Unity→WebGL, ~2 GB / ≤500k objects) is the path to **avoid** for many-small-agents.
- **The rule-grammar freedoms (PhysiCell CBHG / Morpheus / CompuCell3D).** PhysiCell's guardrails (fixed signal/behavior vocab, always-Hill response, additive composition, baseline-phenotype-by-forms) make malformed rules impossible and models composable, at the cost of arbitrary new dynamics. GenesisCA's node graph is the **escape-hatch tier** PhysiCell lacks (Morpheus-like free expressions) — the recommendation is to keep that freedom but **borrow two guardrails**: (1) rule-node sockets that **enumerate live** from the model's current attributes/fields (the Studio dynamic-combobox pattern — already how GenesisCA's `attributeId` dropdowns work); (2) division as a first-class family with an **explicit honest orientation control** (tension/random/field-gradient — never a mislabelled "shape" option). The biggest accessibility win is shipping the **division-rule + chemotaxis + curvature-control macros** as `.gcamacro` templates so a no-code author starts from a working pattern rather than wiring the easy-to-get-wrong hysteresis loop from scratch.

---

## §10 — Appendix

### 10.1 The new node catalogue

> Format: **Name** (root it attaches to) — ports — reads/writes. All `requirements.centerBased` and/or `bondGraph`. Read nodes are `category: 'data'`; flow nodes `category: 'output'`; roots `category: 'event'`.

**Event roots (singletons, `compile: () => ''`):**
- **behaviourStep** — out: `do` (flow) + value-outs `myX`/`myY`(/`myZ`)/`myRadius`/`myArea`/`myBondDegree`/`myAge`/`myType` — the main per-agent update; compiler loops `aIdx<highWater`.
- **divisionEvent** — out: `do` (flow) + value-outs `daughterIndex`/`axisDefaultX`/`axisDefaultY`/`myArea` + motherAttrs — daughter assignment; fires per (dividing agent, daughter).
- **bondContactEvent** — out: `do` (flow) + value-outs `otherType`/`restLength`/`currentLength`/`currentStrain`/`myBondDegree`/`otherBondDegree` — form/break policy; fires per candidate pair.
- **fieldStep** — out: `do` (flow) — the field's own diffusion; loops `idx<fieldW*fieldH` (a lattice).

**Read nodes (`data`, emit one `const _v<id>=…`):**
- **GetBondDegree** (behaviour/division/bondContact) — out: `degree` (int) — reads `_agentBondCount[aIdx]`.
- **SummedBondStrength / MeanBondStrength** (behaviour/division) — out: `value` (float) — reads a per-agent reduction or sums a `ForEachBond` body.
- **NeighbourDensity** (behaviour/division) — out: `density` (float) — reads `_agentDensity[aIdx]`.
- **GetCurvature** (behaviour/division) — config `channel` (lateral/topographical, via `hiddenPorts`); out: `curvature` (float) — reads `_agentCurvature[aIdx]`.
- **GetRadius** (behaviour/division) — out: `radius` (float) — reads `_agentRadius[aIdx]`.
- **GetSelfPosition** (behaviour/division) — multi-out: `x`/`y`(/`z`) (float) — reads position SoA.
- **GetBondedNeighbourAttr** (behaviour) — config `bondSlot`+`attributeId`; in: `slot` (int); out: `value` — reads a partner's attr via the bond list (IIFE-guarded, [GetNeighborAttributeByIndexNode.ts:23-43](../src/modeler/vpl/nodes/GetNeighborAttributeByIndexNode.ts)).
- **SampleField** (behaviour/division) — config `substrateId`; out: `value` (float) [+ optional `∇x`/`∇y`] — bilinear gather at `(x,y)`.
- **FieldGradient** (behaviour/division) — config `substrateId`; multi-out: `∂x`/`∂y`(/`∂z`) (float) — central differences over the bilinear sample.

**Flow nodes (`output`, emit a request — NOT async-only):**
- **divideCell** (behaviour) — config `axisSource`(tension/density/field-gradient), `asymmetry?`; in: `do`(flow), `axisX?`/`axisY?`/`asymmetry?` (float); out: `next`(flow) — writes `_divideRequest`/`_divideAxis*`/`_divideAsym`.
- **killCell** (behaviour) — in: `do`(flow); out: `next`(flow) — writes `_killRequest[aIdx]=1`.
- **formBond** (bondContact/behaviour) — config `typeLabel?`; in: `do`(flow), `targetAgent`(int), `restLength?`/`stiffness?`(float); out: `next`(flow) — writes the bond-request buffer (resolve→guard→RMW).
- **breakBond** (bondContact/behaviour) — in: `do`(flow), `targetAgent`|`bondSlot`(int); out: `next`(flow) — writes the bond-request buffer.
- **setTargetRadius** (behaviour/division) — in: `do`(flow), `value`(float); out: `next`(flow) — writes `w_radius[aIdx]`.
- **secreteToField** (behaviour) — config `substrateId`; in: `do`(flow), `rate`(float); out: `next`(flow) — bilinear 4-voxel splat into the field write buffer (post-step).
- **ForEachBond** (any flow context) — in: `do`(flow); out: `body`(flow), `next`(flow) + per-iteration `partnerId`/`restLength`/`currentLength`/`strength`/`index` — iterates the ragged bond list.

### 10.2 Data structures (TS-ish)

```ts
// --- Schema (additive sub-objects on CAModel, clone of VariegatedCellsConfig) ---
interface BondGraphConfig {
  enabled: boolean;
  maxBonds: number;                       // hard per-agent ceiling (reject on overflow)
  bondClasses: BondClass[];               // type-pair adhesion classes (clone FaceLabelPalette)
  springMatrixAttributeId: string;        // a lookupTable model attr: λ (stiffness) + L (rest length) per class-pair
  formDistance: number;                    // d_form
  breakDistance: number;                   // d_break  (MUST be > d_form — hysteresis)
  division: { axisSource: 'tension' | 'density'; axisWeight: number };
  seeding: 'startBonded' | 'bondOnContact';
}
interface BondClass { id: string; name: string; color: string; }

interface CenterBasedConfig {
  enabled: boolean;
  maxCells: number;                        // over-allocated ceiling (reject on overflow)
  dimensions: 2 | 3;
  worldBounds: { x: number; y: number; z?: number };
  forceLaw: { kind: 'GLS' | 'piecewiseQuadratic' | 'cubic'; /* params via model attrs */ };
  seeding: { mode: 'uniform' | 'latticePerturb' | 'image'; count: number; perTypeFractions?: Record<string, number> };
}

interface FieldConfig {
  enabled: boolean;
  fieldWidth: number; fieldHeight: number;       // reuse gridWidth/gridHeight as resolution
  substrates: FieldSubstrate[];
}
interface FieldSubstrate { id: string; name: string; diffusion: number; decay: number; initialValue: number; secretionAttrId?: string; }

// --- Worker-side SoA (length maxCells; allocated once, free-list recycles) ---
interface AgentStore {
  // positions + geometry (Float64Array, baked into wasmMemory from the WASM phase)
  x: Float64Array; y: Float64Array; z?: Float64Array;     // z only when dimensions===3
  radius: Float64Array; targetRadius: Float64Array;
  age: Float64Array; cyclePhase: Float64Array;
  // identity (Int32Array)
  type: Int32Array; lineage: Int32Array;
  // per-user-attribute SoA arrays (r_<id> / w_<id>, double-buffered) — same naming as lattice
  alive: Uint8Array;                       // the alive-mask (NOT a dense bound — free-list holes)
  highWater: number;                       // loop bound; liveAgentCount is the display tally only
  freeList: Int32Array; freeTop: number;   // recycled slots (register Int32 kind in ATTR_TYPE_MAP)
  // engine-computed per-agent reductions (read by GetBondDegree/NeighbourDensity/GetCurvature)
  bondCount: Int32Array; density: Float64Array; curvature: Float64Array;
  // request buffers the graph writes (validated + applied post-step)
  divideRequest: Uint8Array; divideAxisX: Float64Array; divideAxisY: Float64Array; divideAsym: Float64Array;
  killRequest: Uint8Array;
}

// --- Bond ragged store (per-agent maxBonds slots; SoA over wasmMemory) ---
interface BondStore {
  partner:     Int32Array;   // length maxCells*maxBonds; partner agent id
  partnerEpoch: Int32Array;  // slot-generation tag — checked every read (dangling-bond ABI)
  restLength:  Float64Array; // L
  stiffness:   Float64Array; // λ
  typeLabel:   Int32Array;   // bond class
  strength:    Float64Array; // age/strength
  // _agentBondCount[aIdx] (= AgentStore.bondCount) gives the live length per agent
  formRequest: /* ragged request buffer applied in the post-step structural phase */ ;
}

// --- Field grid (separate iteration domain, length fieldW*fieldH, double-buffered) ---
type FieldGrid = Record<string /*substrateId*/, { read: Float64Array; write: Float64Array }>;
```

---

*Companion: extends [INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md](INVESTIGATION_BOND_GRAPH_MORPHOGENESIS.md) + [INVESTIGATION_CENTER_BASED.md](INVESTIGATION_CENTER_BASED.md) (substrate, the 50-row Impact Map, the full bibliographies). Per CLAUDE.md, the illustrated HTML mockup `PLAN_BOND_GRAPH_MORPHOGENESIS.html` accompanies this plan. Status: implementation plan — no code committed; the §9.2 decisions gate the first build.*

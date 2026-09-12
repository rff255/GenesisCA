# GenesisCA — Project Context for Claude Code

> **How to use this file.** This is the always-loaded core: what the project is, the rules that must
> never be broken, and a map to everything else. It is deliberately small so that every session — even
> a one-line fix — does not pay for the whole project's history.
>
> **Subsystem detail lives in `docs/areas/*.md`. Find your area in [Where things are](#where-things-are--the-routing-table)
> and read that file BEFORE you start editing.** Those files hold the invariants, the gotchas and the
> traps for each subsystem; they were moved out of this file verbatim, so nothing was lost.
>
> **One doc is rarely enough.** Each area doc names the other areas a change there reaches; follow them
> until a pass turns up nothing new — see [Read to CLOSURE](#read-to-closure-not-to-the-first-hit).
> Almost every expensive defect recorded in these docs came from stopping at the first one.
>
> Full build narratives — measurements, verification logs, phase reports, design rationale — live in
> `docs/HANDOFF_*.md`, `docs/PLAN_*.md`, `docs/IMPACT_MAP_*.md` and `docs/INVESTIGATION_*.md`.

---

## What GenesisCA Is

GenesisCA is an IDE for modeling and simulating Cellular Automata (CA). It uses a Visual Programming
Language (VPL) — a node-based graph editor — so users can design arbitrarily complex CA models without
writing code. The goals are **accessibility** (no programming required) and **performance** (grids up to
5000×5000+).

Three coexisting modes in one app: the **Modeler** (design a model — properties, attributes,
neighborhoods, mappings, the update-rules graph), the **Simulator** (run and visualise it — Canvas/WebGL
rendering, the simulation loop in a Web Worker), and **Live** (both at once in a split workspace — edit the
model while it plays). The user switches freely between them; a mode switch never restarts the run.

Beyond the cell lattice the app carries two further tiers, each with its own rule graph:
**bond-graph agents** (off-lattice, force-driven, bondable, dividing) and the **Overseer** (experiment
orchestration — replicates, sweeps, statistics).

---

## Commands

- `npm run dev` — Start Vite dev server (http://localhost:5173)
- `npm run build` — TypeScript check + production build to `dist/`
- `npm run preview` — Preview production build locally
- `npx tsc -b` — type-check (the dev server does **not**; see the pre-commit rule below)

---

## Repository Context

This repository (https://github.com/rff255/GenesisCA) originally contained a Qt/C++ desktop application
built in 2017 as an undergrad final project (Universidade Federal de Pernambuco). The
`legacy_qt_cpp_solution` branch preserves that legacy code — a qmake project with `src/modeler` and
`src/simulator` subdirectories, DearImGui-based node editor, and C++ code generation for model export.

**The current work is a complete rewrite.** `master` is the main branch and ships releases. Active
development happens on feature branches off `master`. The `legacy_qt_cpp_solution` branch is frozen as
historical reference — do not modify.

The old implementation serves as architectural reference. Key file for understanding the old compilation
approach: `src/modeler/UpdateRulesHandler/node_graph_instance.h` — each node had an `Eval()` method that
emitted C++ code snippets, stitched together into `.h`/`.cpp` files, then compiled to `.dll`/`.exe`. The new
version follows the same pattern but targets JavaScript/WASM/WGSL instead of C++.

---

## The stack, and the three engines

**TypeScript + React + Vite**, React Flow for the node editor, Canvas2D + WebGL2 + WebGPU for rendering,
Web Workers for the simulation. The app is **100% client-side** — no backend, no server, no paid hosting
(GitHub Pages / a Tauri shell).

The critical performance decision: **the node graph is compiled at edit time to one of three engines.**
At 5000×5000 the update function runs 25M times per generation, so interpreting the graph is not an option.

| Engine | Role |
|---|---|
| **WebAssembly** | Hand-emitted WASM module. Production engine for most models; exact + seedable (f64, one shared stream), **bit-identical to the JS reference**. |
| **WebGPU** | WGSL compute shaders. Best for very large grids and math-heavy per-cell work. Requires synchronous mode. |
| **Debug / Reference (JS)** | `new Function(...)`. The **semantic reference** the other two are verified against, the always-runnable fallback, and the source **Show Code always displays** — but the slowest. |

Chosen per model by the **Engine** radio (Properties → Execution): `Auto` (default) / WebAssembly / WebGPU,
with Debug (JS) behind an Advanced reveal. Each node type defines `compile()` (JS) plus per-target emitters.
All three compilers are hand-rolled in TypeScript — there is no external toolchain.

→ `docs/areas/architecture.md` for the model definition and the settled decisions;
`docs/areas/engines-and-targets.md` for how an engine is resolved and why a gate might reject one.

---

# The Rules

These are the rules that, when broken, cause real defects in this codebase. They are reproduced here in
full precisely because they are the part no session should have to go looking for.

## Delivery & correctness (non-negotiable)

- **ALL-TARGET DELIVERY (non-negotiable — never ship a JS-only / single-target feature):** every feature MUST run on **all three compile targets (JS / WASM / WebGPU)**, on both the cell grid AND (where applicable) the agent loop, across 2D and 3D. The targets exist for performance (WASM/WebGPU are several-x faster on dense work) — shipping a feature on JS alone, or "clamping to JS when X is used", silently throws that performance away for any model that touches the feature, and is a **regression, not an acceptable shortcut**. "It's harder to emit on WASM/WebGPU", "the value type isn't native there", or "I'll do the other targets later" are **NOT** valid reasons to clamp. The ONLY acceptable single-target restriction is a **fundamental incompatibility** — a property the target's execution model genuinely cannot express — and the bar is the documented set: **async update mode + the async-only neighbour-write nodes on WebGPU** (WebGPU runs cells in parallel; a write visible to a later cell this step is inherently serial), and **order-dependent indicator ops** (`updateIndicator` toggle/next/previous on WebGPU; non-commutative mutation of one shared accumulator by parallel writers). f32-vs-f64 precision and per-cell-PCG-vs-shared-RNG are *documented intentional differences*, not reasons to clamp. When a target lacks NATIVE support for a value/operation, the correct move is one of: **(a) lower it to primitives the targets already compile** — a shared pre-compile graph transform that rewrites the feature into existing nodes BEFORE per-target compile, exactly like [macroExpand.ts](src/modeler/vpl/compiler/macroExpand.ts) (macros → flat nodes), [rerouteCollapse.ts](src/modeler/vpl/compiler/rerouteCollapse.ts) (reroutes → direct edges), [linkedOutputMappings.ts](src/modeler/vpl/compiler/linkedOutputMappings.ts) (linked OM → real colour-pass nodes), and **[expandComposites.ts](src/modeler/vpl/compiler/expandComposites.ts)** (vector/color → scalar nodes); or **(b) emit it natively in each target's compiler** (the WASM encoder + the WGSL builder). Both keep all targets in lockstep with one source of truth. **Before declaring a feature done, prove it compiles + runs on JS, WASM, AND WebGPU** (the dev harness `compileAll` + a real worker run / parity check) — a green tsc + a JS-only check is NOT done. If you ever feel tempted to add a node type to a `JS_ONLY` set or a `detect*Incompatibilities` clamp, STOP: that is the partial-delivery anti-pattern this rule exists to prevent — lower it or emit it instead.
- **2D AND 3D dual impact (mandatory for EVERY change now that both grid kinds ship):** the engine is "incremental 3D" — 2D is the byte-identical fast path and 3D adds the layer axis (`total = W*H*D`, the `_layer` decode, `coords3d`, the 10-bit NI codec). Most code is shared, so a single edit usually touches both, and it's easy to fix/extend one dimension while silently regressing the other (real examples: the dimension-reset drop-guard checked only W/H → 3D-only loop; the soft-recompile `dimsModel` carried only W/H → stale WebGPU `total` after a 3D depth-resize). Before finishing ANY change ask: does it run in a 3D model? a 2D model? Are the grid-dim / `total` / per-cell-coordinate assumptions right for each? **Verify both** (the dev harness + a 3D sample like Life3D AND a 2D sample). This composes with compiler-lockstep — a change must be correct across the **3-target (JS/WASM/WebGPU) × 2-dimension (2D/3D)** matrix.
- **Pre-commit type check:** Vite dev server does NOT type-check — always run `npx tsc -b` before committing to catch TypeScript errors that will fail the CI build. Note: `npx tsc --noEmit` (without `-b`) silently checks nothing because the root tsconfig has `"files": []` and only project references. If `tsc -b` itself errors with a phantom `Cannot read file '.../nodes/tsconfig.json'` (a transient incremental-build / file-lock glitch — seen right after parallel workflow agents touch the tree), just retry it, or run `npx tsc -p tsconfig.app.json --noEmit`, which reliably type-checks the app project (the `--noEmit`-checks-nothing caveat above applies only to the ROOT tsconfig, not the app one).

## UI doctrine

- **AN ENABLED CONTROL MUST DO SOMETHING — hide it when it structurally cannot, grey it when it temporarily cannot (user rule, 2026-08-05).** A control that is visible AND interactable but internally inert is the single most confusing thing the UI can do (the user's report: *"if the option doesn't work for certain targets because of theoretical reasons then it should be hidden… many other options are left visible and interactable when in reality they are internally disabled"*). Two dispositions, and the test is **can the user reach the working state from this panel?**
  - **STRUCTURALLY impossible for the current model / dimension / render path ⇒ HIDE.** The user cannot flip it from here, so a greyed row is just clutter that raises "why is this here?". Examples now enforced: gridlines with no CA grid or in 3D · infinity canvas in 3D · agent Glow / Background / Metaballs(2D) / Vision in 3D · agent Glue/Cut/Bond with `resolveMaxBonds === 0` · Outlines while Metaballs replaces the bodies · Draw-agents-in-front / Cell gaps / Occlusion on an agents-only model · smooth scaling under the E2 composite.
  - **TEMPORARILY unavailable, or one setting away in an adjacent control ⇒ DISABLE IN PLACE with the reason in the tooltip.** Examples: capture settings while recording (locked for the run) · infinity canvas on a non-torus boundary (Boundary is right there in the Settings panel) · the WebM-only Quality / overload rows under GIF (a format choice away) · the Overseer's Run button mid-experiment · the WebGPU stop-check interval on a non-WebGPU model.
  - **A hidden control needs its STATE handled too, not just its markup**: coerce a stranded selection when the model changes (the agent brush falls back to `add`; the CSV `none` delimiter falls back to `auto`), and drop it from any keyboard / wheel CYCLE (Alt+wheel steps `agentBrushModesRef.current`, never the full `AGENT_BRUSH_MODES`). A cycle that lands on a hidden mode is the same bug wearing a different hat.
  - **Do NOT hide on a state the user just set in the same panel** (Show-agents off, a colour mapping not selected) — the causal link is visible, and hiding half a panel per checkbox is worse than the disease.
- **Type-name display convention:** the UI never shows the raw type ids `bool` / `float` — they render as **Binary** / **Decimal** (general-public vocabulary). Route every user-visible type name through `typeDisplayName()` in [typeLabels.ts](src/model/typeLabels.ts) (badges, dropdowns showing `name (type)`, hints); `<option value>` keeps the internal id, only the option TEXT uses the display name. Prose in HelpView/README/NODES_REFERENCE says binary/decimal too (NODES_REFERENCE's port-type table maps id → UI name). Internal ids in schema/configs/compilers/`.gcaproj` are NEVER renamed.
- **Illustrated plans (HTML mockups) — required for UI / behavior changes:** Whenever a plan involves a non-trivial UI change OR any change in behavior, produce a self-contained HTML representation of the plan (inline CSS + inline SVG, no external assets) saved alongside the plan `.md` file, IN ADDITION to the written markdown plan. Use visual mockups to illustrate the proposal — before/after states, interaction gestures/sequences, and data-/control-flow diagrams — so the user can SEE the change, not just read it. **Exempt (trivial):** renames, color tweaks, minor repositioning, copy edits, and pure-internal refactors with no observable behavior change.

## Process & judgment

- **Dismissing a user bug report requires concrete contradicting evidence**, not a plausible-sounding alternative narrative. Byte-level "the data round-trips correctly" is necessary but not sufficient — when the user is certain something is wrong, step the simulation end-to-end and inspect observable behavior (e.g., post-load `getState` + per-step NI histograms). Plausible-sounding stories ("the saved data already has bias, the simulation just preserves it") cost iterations when the actual bug is one indirection away from where you're looking.
- **Debugging blank-screen React crashes:** When the app whites out (React unmounts on uncaught error), console usually only shows generic "error in `<X>` component" warnings without stack traces. Install a `window.onerror` handler via preview_eval BEFORE reproducing, then read captured errors after — this surfaces the real stack trace.
- **Version display:** When bumping version, update ALL FOUR places: `package.json`, `package-lock.json` (root + first `packages.""` entry), the hardcoded version string in `src/App.tsx` header (`v1.X.Y`), and the badge in `README.md` (`<sup>v1.X.Y</sup>`). Easy to miss; sweep with `grep -rn "v1\.[0-9]"` after bumping. The **`/updateversion`** slash command ([.claude/commands/updateversion.md](.claude/commands/updateversion.md)) automates this: pass an explicit `X.Y.Z` or `major`/`minor`/`patch` and it updates all four files.
- **PR descriptions:** Never include "Built with Claude Code" or similar Claude/Anthropic attribution lines. User handles all attribution decisions.

## Code conventions

- Language: TypeScript (strict mode)
- All new code and documentation in English
- Prefer modular, readable code. Each node type is its own file. The compiler is separate from the editor.
- When building new node types, follow the established pattern of existing nodes (compile method, port definitions, UI component)
- `NodeTypeDef` includes optional `description` (one-line summary of what the node does). Include it in new node definitions for Add Node menu tooltips.
- The original undergrad thesis (in Portuguese) exists as reference material but is not part of the codebase
- Do not assume file structure beyond what's documented — check `docs/areas/project-structure.md`, or ask if uncertain.

## Documentation consistency — and where new knowledge goes

- **Keep ALL sources of truth in sync — do this after every feature change, not as an afterthought.** A change
  isn't done until every layer that describes it is updated, because future context-gathering relies on them
  agreeing. Update: (1) the **code itself** — structure + the comments/docstrings near what you changed;
  (2) **`docs/areas/<area>.md`** — the subsystem doc for what you touched (find it in the routing table below);
  add the invariant, the gotcha and the trap, not the run log; (3) **`docs/PROJECT_STRUCTURE` entry** — i.e.
  `docs/areas/project-structure.md` — when files are added or moved; (4) `src/help/HelpView.tsx` (in-app Help
  tab); (5) the root `README.md` (whose `## Features` section is DELIBERATELY high-level — short product-page
  groups, no per-node/per-target inventories; a new feature belongs there only if it changes one of those
  one-to-three-sentence summaries); (6) for node-system changes (new nodes, port types, redundancies) also
  `docs/NODES_REFERENCE.md` (table + node count + Mermaid diagrams). Drift between any of these silently
  degrades every later change, so treat them as one atomic update.
- **"The" area doc is usually more than one.** The areas you had to READ to make the change safely (see
  [Read to CLOSURE](#read-to-closure-not-to-the-first-hit)) are the areas whose docs may now need a line —
  and if you discovered a coupling nobody had written down, say so on *both* ends and add it to the
  `Also read` line, so the next agent's walk reaches it without having to rediscover it.
- **This file (`CLAUDE.md`) is NOT where feature detail goes.** It is loaded into *every* session, so it holds
  only project-wide rules and the routing table. Adding a section here for a feature costs every future session
  forever. **`node scripts/check-claude-md-budget.mjs` enforces it** — see [Keeping this file small](#keeping-this-file-small).
- **The narrative belongs in `docs/`, not in a reference doc.** Measurements, verification transcripts, "verified
  in-browser, 0 console errors", per-phase reports and design rationale go in `docs/HANDOFF_*.md` /
  `docs/PLAN_*.md` / `docs/IMPACT_MAP_*.md`. An area doc should read as *reference* — what is true and what will
  bite you — with a pointer to the handoff for the story.

---

# Where things are — the routing table

**Read the area doc for what you are about to touch, before you touch it.** Each one carries that
subsystem's invariants, its known traps, and the reasoning behind decisions that look arbitrary from the
outside. They are large; they are meant to be read on demand, not memorised.

Browsable index with sizes: [`docs/areas/README.md`](docs/areas/README.md).

### By source path

| You are touching | Read first |
|---|---|
| `src/modeler/vpl/compiler/**` — the shared passes (sinking, CSE, hazards, lowerings) and JS emit | `docs/areas/compiler-core.md` |
| `src/modeler/vpl/compiler/expandComposites.ts`, `vectorAttr.ts`, `colorHex.ts`, anything about a value's TYPE | `docs/areas/value-types.md` |
| `src/modeler/vpl/compiler/variegation.ts`, `subAttribute.ts`, `linkedOutputMappings.ts` | `docs/areas/cell-features.md` |
| `src/modeler/vpl/compiler/wasm/**` | `docs/areas/compiler-wasm.md` |
| `src/modeler/vpl/compiler/webgpu/**`, `webgpuRuntime.ts` | `docs/areas/compiler-webgpu.md` |
| `src/modeler/vpl/compiler/agentWasm/**`, `agentWebgpu/**` | `docs/areas/agent-compilers.md` |
| `src/modeler/vpl/compiler/agentAbi.ts`, `src/model/agentCapabilities.ts` | `docs/areas/agent-capabilities.md` |
| `src/modeler/vpl/nodes/**` — a node DEFINITION (ports, config, validation) | `docs/areas/compiler-core.md`; an agent node → `docs/areas/agent-nodes.md` |
| `src/modeler/vpl/**` — the graph editor, `CaNode`, node UX, reroutes, clipboard | `docs/areas/modeler-ui.md` |
| `src/modeler/panels/**` — the Modeler's side panels | `docs/areas/modeler-ui.md` |
| `src/simulator/engine/sim.worker.ts`, the SoA grid, stepping, sparse stepping | `docs/areas/simulation-engine.md` |
| `src/simulator/engine/agentEngine.ts` — forces, bonds, division, the field bridge | `docs/areas/agent-engine.md` |
| `src/simulator/engine/agentWebgpuRuntime.ts` render paths, `drawAgentsOverlay` | `docs/areas/agent-render.md` |
| `src/simulator/SimulatorView.tsx` — canvas, transport, capture, panels | `docs/areas/simulator-ui.md` |
| `src/live/**`, `src/simulator/simLayoutState.ts` — **Live** mode (the split workspace) | `docs/areas/simulator-ui.md` § *LIVE mode*, then `modeler-ui.md` § *LIVE mode* |
| `src/trace/**`, `src/simulator/engine/traceRunner.ts`, `traceProtocol.ts`, `simTransportState.ts`, the `trace` option in `compile.ts` | `docs/areas/rule-trace.md` |
| the agent brush inside `SimulatorView.tsx` | `docs/areas/agent-brush-ui.md` |
| `src/simulator/render/gl3d.ts`, the voxel renderer, the 3D viewport | `docs/areas/grid-3d.md` |
| `src/model/fileOperations.ts`, `.gcaproj` / `.gcastate` / presets / CSV / export | `docs/areas/io-and-formats.md` |
| `src/simulator/geotiffImport.ts`, `geojsonImport.ts`, `csvImport.ts` (`.asc`), georef | `docs/areas/gis.md` |
| `src/modeler/vpl/compiler/overseer/**`, `overseerRuntime.ts`, `ExperimentsPanel.tsx` | `docs/areas/overseer.md` |
| `src/model/ModelContext.tsx` — the reducer and the delete/rename **cascades** | the area doc for the element type (attributes → `compiler-core.md`, macros → `macros.md`, indicators → `indicators.md`, …) |
| `public/models/**`, `scripts/gen-*.mjs` | `docs/areas/model-library.md` |
| `scripts/*.mjs` harnesses | `docs/areas/testing-harnesses.md` |
| anywhere — "where does X live?" | `docs/areas/project-structure.md` |

### By topic

| The thing you are doing | Read first |
|---|---|
| Adding or changing a **node type** | `docs/areas/compiler-core.md` (+ the per-target docs, + `docs/NODES_REFERENCE.md`) |
| Adding or changing an **agent node** | `docs/areas/agent-nodes.md` |
| Adding a **value type**, an attribute type, or anything about **colour / alpha** | `docs/areas/value-types.md` |
| **Variegation**, sub-attributes, lookup tables, the auto colour pass | `docs/areas/cell-features.md` |
| Changing the **model schema** (`types.ts`) or a file format | `docs/areas/architecture.md` |
| A model **runs on an unexpected engine**, or a gate rejects it | `docs/areas/engines-and-targets.md` |
| **Macros** — defs, expansion, references, explicit controls | `docs/areas/macros.md` |
| **Indicators**, charts, end conditions, stop events | `docs/areas/indicators.md` |
| **Bond topology** — bond attributes, the request queue, rewiring | `docs/areas/graph-rewriting.md` |
| Anything that must also work in **3D** | `docs/areas/grid-3d.md` |
| **Agent capabilities** / physics profiles / the agent ABI | `docs/areas/agent-capabilities.md` |
| Emitting an agent graph on **WASM or WebGPU** | `docs/areas/agent-compilers.md` |
| **GPU residency**, direct render, the UI-sync policy | `docs/areas/agent-render.md` |
| **Tracing** a cell's / an agent's rule in Live (Rule Trace) — the lit path, breakpoints, the Trace panel | `docs/areas/rule-trace.md` |
| Writing or extending a **verification harness** | `docs/areas/testing-harnesses.md` |

---

# Read to CLOSURE, not to the first hit

**The routing table gives you an ENTRY POINT, not the reading list.** Each area doc names the other
areas a change there reaches — in its `Also read` line and inline in the prose — and following those
names is **not optional**. Nearly every expensive defect recorded in these docs was written by someone
who read one doc, made a locally-correct change, and never learned that the thing they touched has a
mirror somewhere else.

**The procedure, every time:**

1. **ROUTE** — find the area for what you are about to edit, and read it.
2. **BLAST RADIUS** — from what you now know, list every OTHER area your change reaches. The table
   below is the floor, not the ceiling.
3. **FOLLOW** — read those docs too, including the parts that look unrelated to your fix. That is where
   the mirror you did not know about is described.
4. **REPEAT** until a pass turns up nothing new. *Then* write code.

Re-skipping a doc you have already read costs nothing. A doc you never opened costs a silent,
plausible-looking bug that compiles, passes tsc, and is caught by no gate. **Stopping at the first doc
that answers "how do I make this work" is the failure this rule exists to prevent** — so is asking a
subagent for a summary in place of reading the area doc yourself.

| If your change… | you MUST also read |
|---|---|
| emits or changes **compiled output** — any node, any pass, even an error string | every per-target doc for that layer (`compiler-wasm.md`, `compiler-webgpu.md`, `agent-compilers.md`): ALL-TARGET DELIVERY is non-negotiable, and `check-compile-identity` hashes error strings too |
| touches an **agent node** | `agent-nodes.md` → `agent-compilers.md` (three emitters) → `agent-capabilities.md` (does it need a capability? an ABI field?) → `agent-engine.md` (does the engine read what it writes?) |
| touches the **agent SoA, a memory layout, or an ABI** | `agent-capabilities.md` (the descriptor + the gates), `agent-compilers.md` (every mirror), `agent-render.md` (the snapshot and the GPU round-trip). A missed mirror shifts every later field silently. |
| touches **any per-cell or per-agent geometry** | `grid-3d.md` — 2D and 3D are one code path plus a layer axis, and fixing one while regressing the other is the most common defect in this repo |
| adds or changes a **UI control** | `modeler-ui.md` or `simulator-ui.md` for the doctrine (hide vs grey vs tooltip), **plus** the area doc for whatever the control actually resolves |
| changes **what a model can declare** (`types.ts`) | `architecture.md`, then every area that READS the new field — a resolver has one home and many callers |
| **deletes or renames** a model element | the element's own area doc for the `ModelContext` cascade, **and** `macros.md` (element references travel inside `.gcamacro`) |
| changes a **worker message** | `simulation-engine.md`, `agent-render.md` (staleness + defer sets), and `io-and-formats.md` if the payload can be serialised |
| touches **rendering** | `agent-render.md` and `grid-3d.md` — the free/frame flip means one visual can have three implementations that must agree |
| adds a **fast path or a gate** | `engines-and-targets.md` — every verdict must come from the function that ENFORCES it, never a re-implementation |

**The same closure decides where the documentation goes when you finish**: every area you had to READ
is an area whose doc may now need a line. See *Documentation consistency* above.

---

## Verification gates

This project's regression net is its 68 Node harnesses in `scripts/` — they run the SHIPPED modules, assert
**values** (not "it compiled"), and are **negative-controlled** (a deliberate source mutation must make them
fail). Full index + house style: `docs/areas/testing-harnesses.md`.

The two that gate almost everything:

- **`node scripts/check-compile-identity.mjs --compare <baseline>`** — hashes every shipped model's emitted
  output on every surface (JS step / grid-init / WASM bytes / WGSL / agent behaviour / division / init /
  overseer). Run it after ANY compiler-adjacent change; "N models, all surfaces unchanged" is the standard
  claim for a presentation-only change. **A new emitted surface MUST be added to its list.**
- **`node scripts/parity-agent-wasm.mjs`** — JS↔WASM bit-parity across every agent sample. Parity is a
  *mirror* test and passes when both targets are equally wrong, so entries carry a VALUE `invariant(store)`
  that recomputes the expected answer independently.

Plus `npx tsc -b` and `npm run build` before calling anything done.

---

## Performance Targets

- Target grid size: up to 5000×5000 (25 million cells)
- Target generation time: under 2 seconds for typical rules at max grid size
- The UI must never freeze during simulation (Web Worker isolation)
- Grid rendering must maintain interactive frame rates for pan/zoom at large sizes

---

## What NOT to Do

- No server-side computation. Everything runs in the browser.
- No paid hosting dependencies. GitHub Pages or equivalent free static hosting.
- No external compilation toolchains. The graph compiles to WASM, WebGPU, or JS inside the browser instantly —
  all three compilers are hand-rolled in TypeScript.
- Do not modify the `legacy_qt_cpp_solution` branch. It is frozen as historical reference.
- All new work goes on feature branches off `master`.

---

## Keeping this file small

`CLAUDE.md` is injected into **every** session. It was 6,753 lines / 1.85 MB (≈460K tokens) before the
2026-09-06 split, which meant a one-line fix paid for the entire project history. The subsystem detail now
lives in `docs/areas/*.md` and is read on demand.

**Budget: 600 lines / 60 KB.** Enforced by:

```bash
node scripts/check-claude-md-budget.mjs
```

If your change needs more room here, it almost certainly belongs in an area doc instead. The test: *would a
session working on an unrelated part of the codebase be worse off without this?* If no, it is area detail.

Add a new area doc when a genuinely new subsystem appears — give it a row in the routing table above, and
that is the only edit this file should need.

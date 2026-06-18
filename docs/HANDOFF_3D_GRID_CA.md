# HANDOFF — Build the 3D Grid CA milestone for GenesisCA

> **You (the next session) are being handed a fully-scoped, build-ready ticket.** A prior investigation + plan effort produced two design docs ([PLAN_BG_DIMENSIONS_AND_MODES.md](PLAN_BG_DIMENSIONS_AND_MODES.md) + its `.html` mockup, and the upstream [PLAN_BOND_GRAPH_MORPHOGENESIS.md](PLAN_BOND_GRAPH_MORPHOGENESIS.md)) and a subsystem-by-subsystem build-depth audit. The user has chosen the **3D Grid CA** as the first build milestone. This document is your **runbook**: an ordered list of small PRs, each with a concrete change, a runnable acceptance test, and a lockstep note. Execute it PR-by-PR. Do not re-derive the design — it is settled below and cited (`file:line`).
>
> This mirrors the style of [docs/HANDOFF_CENTER_BASED_INVESTIGATION.md](HANDOFF_CENTER_BASED_INVESTIGATION.md) — a runbook, not an essay. The difference: that one was a *research* handoff ("present, then ask"). **This one is an implementation handoff — you write app code, PR by PR, and verify each before moving on.**

---

## §0 — Mission, scope, and how to verify in this repo

### 0.1 Mission

Add a **3D Grid Cellular Automata** mode to GenesisCA. Today every model is a 2D lattice: a fixed `W×H` grid of sites, one Structure-of-Arrays typed array per attribute indexed by site, a precomputed neighbour-index table, and a 2D `ImageData` canvas blit. This milestone makes the lattice a **`W×H×D` volume** end-to-end: the schema, the three compile targets (JS → WASM → WebGPU), 3D neighbourhood editing, authorable RGBA transparency, a brand-new WebGL2 voxel renderer, and the save/load + indicators + inspector consumer-scan.

**The headline honesty (carried from the plan, [PLAN §1.4](PLAN_BG_DIMENSIONS_AND_MODES.md)):** *3D-is-easy is true of the engine, not the renderer.* The engine 3-ification is overwhelmingly incremental — `total = W*H*D`, a z-decode, a 3-tuple offset table; a cell is still one entity per index. The 3D **renderer is wholesale new**: the entire shipping path is a hard `getContext('2d')` ImageData blit ([SimulatorView.tsx:752-755,780-784](../src/simulator/SimulatorView.tsx)) that the brush/gridline/glyph overlays are welded to — you **cannot** `getContext('webgl2')` on that same canvas element. Treat "3D is a flag flip" as the half-truth it is.

### 0.2 In scope (this milestone)

1. **M0a mode plumbing** — Properties → Execution gains a **Dimension** radio (2D/3D) + **Topology** checkboxes (Grid Cells / Bond-Graph Agents, ≥1 checked, **AGENTS gated/disabled this milestone**) + the schema fields (`dimension`, `gridDepth`, `topologyMode`) + reducers + the ≥1 invariant + the absent-defaults-to-2D-grid migration.
2. **The 3D CA engine (JS)** — `total = W*H*D`, 3D neighbour offsets, the 3D coordinate decode on JS, then **lockstep to WASM and WebGPU**.
3. **3D neighbourhood editing** — coords become 3-tuples; **parametric named-shape generators** (ball/shell/Moore/von-Neumann/ring/disk/range-N) as the primary path + a **2D-slice-stack editor** for hand-tuning; per-index tags via the slice editor only; **direct neighbour-picking FORBIDDEN in 3D** (the `neighborIndex` codec is 2-axis-only).
4. **Authorable RGBA alpha** — unpin `colors[idx+3]=255`, route an authored alpha through Set Cell Looks + colour mappings on all 3 targets, flip the WebGPU canvas `alphaMode`.
5. **The WebGL2 3D renderer** — instanced cubes from the RGBA colors buffer, orbit camera, a **clip/slice plane as the PRIMARY see-inside** (NOT depth-sort), per-cell alpha opt-in, GPU colour-id picking, recording/screenshot capture.
6. **The 3D consumer-scan** — save/load `dimension`+`gridDepth`+3D arrays, spatial indicators 3rd axis (`'layers'`), inspector 3D decode.

### 0.3 Explicitly OUT OF SCOPE (state this prominently)

- **Bond-graph AGENTS**, bonds, division, the field/stigmergy coupling, the `SecreteToField`/`SampleField` nodes ([PLAN §4](PLAN_BG_DIMENSIONS_AND_MODES.md)). The Topology "Bond-Graph Agents" checkbox is **rendered but hard-disabled** ("coming soon") this milestone.
- **The two-graph Modeler split** / `agentGraphNodes` / the `activeGraph` sub-tab swap ([PLAN §3.3, §1.5 C1](PLAN_BG_DIMENSIONS_AND_MODES.md)). A 3D grid CA needs **no** second graph.
- **Variegated-cells-in-3D** — variegation stays **2D-only**. The orientation buffer, the 8-face `DIRECTION_TAGS`, the `& 3` / `& 7` rotation arithmetic, and the facing emitters are all 2D-locked ([PLAN §7](PLAN_BG_DIMENSIONS_AND_MODES.md)). When `dimension==='3d'`, variegation is forced off / its V-tab elided. **Do not touch the facing emitters** (`wasm/compile.ts:1699+/1846+/4650+/5588+`).
- The **3-axis `neighborIndex` codec redesign** — `packNI`/`unpackNI` pack exactly two 16-bit offsets; a 3rd axis is explicitly **deferred** ([PLAN §6.5](PLAN_BG_DIMENSIONS_AND_MODES.md)).

**Lockstep-as-you-go rule:** WebGPU/WASM may lag JS *within a PR sequence* (PR2 ships JS, PR5 ships WASM, PR6 ships WebGPU), but the milestone **targets all three**. Per the project's compiler-lockstep policy, you do NOT merge a permanently JS-only 3D engine — the WASM and WebGPU ports are mandatory PRs in this plan, not optional follow-ups.

### 0.4 How to verify in this repo

Three verification surfaces, used at every PR:

**(a) `tsc -b` before every commit.** Vite's dev server does NOT type-check. Run `npx tsc -b` (or, if it hits the phantom `nodes/tsconfig.json` glitch, `npx tsc -p tsconfig.app.json --noEmit`). The new `WorkerMsg` `depth`/`coords3d` fields, the `MemoryLayout`/`WebGPULayout` `gridDepth` fields, and `Neighborhood.coords3d?` must type-check with no `T | undefined` index errors — guard array reads as `nbr.coords3d ? coords3d[n]! : coords[n]!`.

**(b) The cross-target compiler-import harness (byte-shape parity, NO UI).** This is the load-bearing parity check and the regression guarantee. With `npm run dev` running, a single `preview_eval` imports all three compilers and compares emitted output. The pattern:

```js
// cache-bust EVERY import — Vite's dev module cache is sticky for compiler files
const t = '?t=' + Date.now();
const { compileGraph } = await import('/src/modeler/vpl/compiler/compile.ts' + t);
const { compileGraphWasm } = await import('/src/modeler/vpl/compiler/wasm/compile.ts' + t);
const { computeLayoutFromModel } = await import('/src/modeler/vpl/compiler/wasm/layout.ts' + t);
const { compileGraphWebGPU } = await import('/src/modeler/vpl/compiler/webgpu/compile.ts' + t);
const { EMPTY_MODEL } = await import('/src/model/defaultModel.ts' + t);

// Build a minimal model, then:
const js  = compileGraph(m.graphNodes, m.graphEdges, m);            // → .stepCode (string)
const L   = computeLayoutFromModel(m);                              // → .total (number)
const wa  = compileGraphWasm(m.graphNodes, m.graphEdges, m);        // → .bytes (Uint8Array)
const wg  = compileGraphWebGPU(m.graphNodes, m.graphEdges, m);      // → .shaderCode (string)
// assert on js.stepCode / L.total / wa.bytes / wg.shaderCode
```

Two uses: **3D-correctness** (assert the 3D model's `stepCode` contains `_layer=(idx/WH)|0`, `L.total===64` for a 4³ grid, `wg.shaderCode` includes `idx >= 64u` + the 3D `nbrCellIdx` decode); and **2D byte-identity regression** (compile an existing library model BEFORE and AFTER the change and assert `js.stepCode` string-equal, `wa.bytes` byte-equal via `Array.from(bytes).join()`, `wg.shaderCode` string-equal). The 2D byte-identity test is how you prove the `gridDepth===1` fast path emits the verbatim current code and keeps the WebGPU pipeline cache (`shaderHashOf`) from invalidating.

**(c) The worker via `window.__simWorker` + `getState` (headless engine correctness).** `window.__simWorker` is exposed in DEV ([SimulatorView.tsx](../src/simulator/SimulatorView.tsx)) for direct `postMessage`. After init, `window.__simWorker.postMessage({type:'getState'})` returns all cell attribute arrays — independently recompute the expected 3D neighbour resolution / live-cell histogram and assert 0 mismatches. This is how you verify the 3D engine **before any renderer exists** (a totalistic 3D-Life rule needs only the neighbour count).

**(d) `preview_eval` for UI.** The `dev` config in `.claude/launch.json` serves Vite on **port 51730**. `preview_eval` has a **30s tool timeout** — keep evals short, break long click→wait chains into multiple evals, check intermediate state between them. `preview_screenshot` times out (~30s) on heavy pages — prefer DOM-query `preview_eval` checks. Synthetic pointer events do NOT reliably drive React Flow / canvas drags — add **DEV-only `window.__*` hooks** (the precedent is `window.__simWorker`, `window.__openConnectionDropMenu`) for camera/pick/clip verification.

---

## §0.5 — Critique corrections — APPLY THESE (they amend the PRs below)

An adversarial review of this runbook found the design sound but caught several **ship-a-bug** issues. They are authoritative; where they conflict with a PR section below, **§0.5 wins**. Read this before starting.

### Two BLOCKERS — do these or you will silently corrupt models

**B1 — MERGE PR2 + PR3 into ONE atomic PR.** They are presented below as two independently-mergeable PRs ("PR2 — JS engine", "PR3 — JS compiler decode"), but they are **two halves of one positional ABI** and **cannot ship separately**:
- PR2 edits the worker's `buildLoopArgs` ([sim.worker.ts:938](../src/simulator/engine/sim.worker.ts)) + `buildCellArgs` ([:967](../src/simulator/engine/sim.worker.ts)) to inject `depth, W*H` into the arg list.
- PR3 edits the compiler's `buildLoopParams` ([compile.ts:1145](../src/modeler/vpl/compiler/compile.ts)) + `buildCellParams` ([:1170](../src/modeler/vpl/compiler/compile.ts)) + `omParamParts` ([:1819](../src/modeler/vpl/compiler/compile.ts)) to **receive** them in the same slot.

Ship PR2 without PR3 and every JS-compiled step receives `[total, W, H, depth, WH, r_attr0, …]` where the compiled function's parameter list still expects `[total, W, H, r_attr0, …]` — so `depth`/`WH` bind onto `r_attr0`/`w_attr0` and **every JS model silently corrupts**. All of `runStep` ([:1192](../src/simulator/engine/sim.worker.ts)), `runInit` ([:1853](../src/simulator/engine/sim.worker.ts)), `runColorPass` ([:1901](../src/simulator/engine/sim.worker.ts)) share `buildLoopArgs`; InputColor shares `buildCellArgs`. **Treat PR2+PR3 as one PR ("PR2 — JS 3D engine + decode"), and its acceptance test MUST run the COMPILED 3D-Life step end-to-end** (the offset-table `getState` check alone passes even with this corruption, because it never exercises the compiled step). Renumber the rest mentally, or keep the labels but never merge PR2 without PR3.

**B2 — Add `gridDepth` + `dimension` to the structural-reinit trigger, in PR1.** `needsFullInit` ([SimulatorView.tsx:1916-1930](../src/simulator/SimulatorView.tsx)) compares `gridWidth`/`gridHeight`/boundary/updateMode/attrs — but **NOT `gridDepth` and NOT `dimension`**. Without adding them, a user changing Grid Depth (or flipping 2D→3D) triggers only a **soft recompile** (which preserves the old `W*H` buffers) — the new depth never allocates, and the WASM/WebGPU baked `total` literal diverges from the JS arg. Add `|| prev.properties.gridDepth !== model.properties.gridDepth || prev.properties.dimension !== model.properties.dimension` to that list **in PR1** (so the field exists and the trigger is ready before PR2 makes `total` depend on it). This is the single most important omission in the draft.

### Per-PR amendments

- **PR1.** (a) Apply **B2** here. (b) Confirm the legacy 2D byte-identity test explicitly covers that seeding `gridDepth:1`/`dimension:'2d'` in `EMPTY_MODEL` keeps the compiler-import 2D output byte-identical.
- **PR2 (= PR2+PR3 per B1).** Also 3-ify the **`paint` / `paintManual` / `writeRegion` / `clearRegion`** worker handlers' `idx` math to carry the depth term — PR8's picking writes through this path, and 3D painting writes the wrong cell otherwise. If you emit the InitEvent `_v${id}_z = _layer` decode, you **must** also add the **`z`/`maxZ` output ports** to `InitEventNode` ([InitEventNode.ts:24-27](../src/modeler/vpl/nodes/InitEventNode.ts)) — otherwise the decode is dead code with no wire target (and the procedural-3D sample model needs to read the layer). Ports-or-no-decode; don't ship a half.
- **PR4.** Gate the **WASM-default trap**: `EMPTY_MODEL.useWasm = true`, so a 3D model authored after PR4 but before PR5/PR6 runs the **un-3-ified WASM lattice silently**. When `dimension==='3d'` and the WASM/WebGPU 3D ports haven't landed, **force the compile target to JS** (or block 3D authoring) until PR6 merges. Also: `coords` (2D) must stay populated as the fallback the WASM/WebGPU layouts still read (see PR5/PR6).
- **PR5 (WASM).** The fix is **not only** the encoder/`nbrBytes` stride — the WASM **layout's `neighborhoods` mapper** ([wasm/layout.ts:410](../src/modeler/vpl/compiler/wasm/layout.ts), `coords: n.coords`) independently re-derives the table from `n.coords` and **drops `coords3d`**. It must read `coords3d` so the nbr-region sizing (`total * coords.length`, [:285,288](../src/modeler/vpl/compiler/wasm/layout.ts)) uses the 3D length. A 3D neighbourhood with empty `coords` + populated `coords3d` would size the region to 0.
- **PR6 (WebGPU).** Same two sites: `computeWebGPULayout`'s `neighborhoods` mapper **and** the `nbrBytes` stride ([webgpu/layout.ts:205](../src/modeler/vpl/compiler/webgpu/layout.ts)) must read `coords3d`. Add a harness assertion that `wg.shaderCode` contains `idx >= ${W*H*D}u` (the baked entry-point bound) so a stale `dimsModel` that lost `gridDepth` is caught.
- **PR7 (alpha).** (a) The WebGPU `alphaMode` flip ([webgpuRuntime.ts:516](../src/simulator/engine/webgpuRuntime.ts)) is **canvas-global** — it affects every existing WebGPU-direct 2D model, not just 3D. Add a before/after regression of an existing WebGPU 2D model proving `a=255` premultiply is identity. (b) `ColorScale`/`CategoricalColor` gain an `a` output — but the **linked-output-mapping synthesizer** ([linkedOutputMappings.ts](../src/modeler/vpl/compiler/linkedOutputMappings.ts)) builds those nodes with RGB-only config; supply a **default `a=255`** there or linked-OM models emit undefined `_v${id}_a`. (c) Thumbnail capture must force opaque.
- **PR8 (renderer).** (a) **HARD-disable WebGPU rendering when `dimension==='3d'`** — WebGPU-direct render skips the colors readback ([sim.worker.ts:2301](../src/simulator/engine/sim.worker.ts)), so `colorsRef` is null and the GL renderer draws nothing with **no error**. Force JS/WASM (which ship colors to the main thread) for 3D. (b) The recording **2D-direct branch** ([SimulatorView.tsx:1318](../src/simulator/SimulatorView.tsx)) reads grid-res `w*h*4` and must be **skipped** (early-return) for 3D, not supplemented. (c) Verify alpha via a **colors-buffer readback** (`colorsRef[idx*4+3] === authoredAlpha`), **not** `preview_screenshot` (it times out on heavy pages).
- **PR9 (consumer-scan).** (a) Extend the **`hasSpatialIndicators` gate at [sim.worker.ts:1959](../src/simulator/engine/sim.worker.ts)** to include `'layers'` (the draft cites the `isSpatial` checks at 1203/1505/2090 but misses 1959 — the gate that decides whether `computeSpatialIndicators` runs **at all**), plus the SimulatorView-side `hasSpatialIndicators` setter. (b) The worker must **echo `depth` in its `getState` payload** (cite the getState assembly site) or `serializeSimState` reads `workerState.depth` as `undefined` and saves `depth=1` — silently truncating a 3D grid to its first `W*H` cells on reload. (c) Enforce with a grep that **every `gridDepth.current =` sits beside a `gridWidth.current =`** (init, resize, `applySimulationState`).

---

## §1 — The agreed design recap

**Read these two design docs first** (they are the spec; this handoff is the build ticket):

- [PLAN_BG_DIMENSIONS_AND_MODES.md](PLAN_BG_DIMENSIONS_AND_MODES.md) — the direct parent. §1.5 (critique corrections C1–C5), §3 (mode UI), §5 (the three engine seams), §6 (3D neighbourhoods + the industry-norm grounding), §7 (variegated deferral), §8 (RGBA alpha + the transparent renderer + the clip-plane-first decision C4/D2). Its companion `.html` mockup illustrates the Execution panel + the parametric/slice editor.
- [PLAN_BOND_GRAPH_MORPHOGENESIS.md](PLAN_BOND_GRAPH_MORPHOGENESIS.md) — the upstream bond-graph design. Out of scope here except that the Topology checkbox + vocabulary originate there.

**The key decisions you are implementing (all already made — do not relitigate):**

1. **Three engine seams, all incremental** ([PLAN §5.1](PLAN_BG_DIMENSIONS_AND_MODES.md)): `total = W*H*D`; the offset-table loop gains a `layer` dimension + reads 3-tuples; the per-cell decode preamble gains `_layer`. The flat resolved neighbour-table **stride stays `coords.length`**, so every downstream neighbour-access node is byte-compatible and 3D-for-free.
2. **`gridDepth===1` fast path on all three targets** — emit the EXACT current 2D code so existing models are byte-identical (regression guarantee + WebGPU pipeline-cache stability).
3. **Parametric 3D neighbourhoods are the industry norm** ([PLAN §6.2](PLAN_BG_DIMENSIONS_AND_MODES.md): Golly/CompuCell3D/Morpheus/3D-Larger-than-Life are all named-shape + radius). Ship parametric generators (primary) + a 2D-slice-stack editor (hand-tuning). Direct neighbour-picking is forbidden in 3D (2-axis codec). Tags only via the slice editor.
4. **Variegated deferred to a later milestone** ([PLAN §7.2](PLAN_BG_DIMENSIONS_AND_MODES.md)) — gate it off in 3D.
5. **Authorable alpha is "unpin the byte," not "add a channel"** ([PLAN §8.1](PLAN_BG_DIMENSIONS_AND_MODES.md)) — the colors buffer is already RGBA; alpha is forced to 255 at three emit sites + two fallbacks. Default MUST stay 255 everywhere.
6. **Clip/slice plane is the PRIMARY 3D see-inside, NOT depth-sort** ([PLAN §1.5 C4, §8.4, D2](PLAN_BG_DIMENSIONS_AND_MODES.md)) — depth-sorted alpha blending is *incorrect* on interpenetrating geometry (the exact dense-interior moment 3D exists to show). Per-cell alpha is opt-in; weighted-blended OIT is a v2 upgrade.
7. **The naming collision** ([PLAN §2, the audit](PLAN_BG_DIMENSIONS_AND_MODES.md)): `ModelProperties.topology: Topology = '2d-grid'` ALREADY EXISTS ([types.ts:152,203](../src/model/types.ts); [defaultModel.ts:12](../src/model/defaultModel.ts)) as a legacy string enum. The new checkbox sub-object is `topologyMode` (NOT `topology`). Leave the legacy field untouched.

---

## §2 — The PR plan

Nine ordered PRs (each small, `tsc`-clean, and verifiable) — **except PR2+PR3, which merge as ONE PR per §0.5 B1** (the worker/compiler ABI halves). The sequence respects the dependency chain: schema first, then the JS engine end-to-end (headless-testable), then the cross-target lockstep, then neighbourhood editing, then alpha, then the renderer, then the consumer-scan. Apply the §0.5 amendments as you reach each PR.

```
PR1 ─ M0a schema + UI + migration  (no behaviour change)
PR2 ─ Worker 3D engine (JS) + 3D-Life sample model   ← headless-verifiable, no renderer
PR3 ─ JS compiler 3D decode
PR4 ─ 3D neighbourhood schema + parametric generators + slice-stack editor + gate tags/picking
PR5 ─ WASM 3D port    (lockstep)
PR6 ─ WebGPU 3D port  (lockstep)
PR7 ─ RGBA authorable alpha (3 targets + WebGPU alphaMode)
PR8 ─ WebGL2 3D renderer  (static → camera → clip-plane → alpha → picking → capture)
PR9 ─ save/load + indicators + inspector 3D consumer-scan
```

> **Branch discipline:** all work on a feature branch off `master` (e.g. `grid_3d`). Never push, never add Co-Authored-By lines (the user handles all git). Per CLAUDE.md, a non-trivial UI change needs an illustrated HTML mockup — PR1 ships one for the Execution panel; PR4 for the neighbourhood editor; PR8 for the 3D viewport (the plan's `.html` mockup is the starting point).

---

### PR1 — M0a schema + UI + migration

**Goal.** Add the `dimension`/`gridDepth`/`topologyMode` schema fields, the Properties → Execution Dimension radio + Topology checkboxes (Agents hard-disabled), the reducer with the ≥1-topology invariant, and the absent-defaults-to-2D migration. **No behaviour change** — `gridDepth` is purely serialized/validated, defaulting to 1; the worker still computes `total = W*H`.

**Files & symbols.**
- `src/model/types.ts:152` (legacy `Topology` enum — leave), `:207-208` (`gridWidth`/`gridHeight`), `:235` (end of `ModelProperties`), `:287` (`IndicatorXAxis`), `:373-374` + `:409` (`SimulationState`), `:539` (`CAModel`, after `variegatedCells?`).
- `src/model/defaultModel.ts:7-21` (`EMPTY_MODEL.properties`), `:28` (after `macroDefs: []`).
- `src/model/ModelContext.tsx:159-192` (action union), `:892-900` (`UPDATE_VARIEGATED_CELLS` reducer template), `:697-752` (`LOAD_MODEL` migration guards), `:1044` (`ModelContextValue` interface), `:1240-1244` (`updateVariegatedCells` callback), `:1311` (value object), `:1357` (useMemo deps).
- `src/modeler/panels/PropertiesPanelContent.tsx:17` (`useModel()` destructure), `:90-131` (Structure section + Grid W/H `NumberField`s), `:133-304` (Execution section), `:204-282` (Compile-Target radio template), `:288-304` (Variegated checkbox template), `:44-45` (`isSpatialIndicator`).

**The change.**

`types.ts` — additive optional fields (old files load unchanged):
```ts
// :152  (after the legacy Topology line — do NOT touch Topology)
export type Dimension = '2d' | '3d';

// :208  inside ModelProperties, after gridHeight
gridDepth?: number;      // default/absent = 1 → W*H*1 === W*H, 2D byte-identical

// :235  end of ModelProperties
dimension?: Dimension;   // absent → '2d' (legacy + all existing files)

// :287
export type IndicatorXAxis = 'generation' | 'rows' | 'columns' | 'layers';  // +'layers' (Z spatial axis, 3D only)

// new interface ABOVE CAModel (≈ :519) — NOTE: TopologyMode, NOT Topology
export interface TopologyMode { gridCells: boolean; agents: boolean; }

// :539  CAModel, after variegatedCells?
topologyMode?: TopologyMode;   // absent → { gridCells:true, agents:false }; ≥1 reducer-enforced

// SimulationState  :374 after height? → depth?: number;   :409 after gridHeight? → gridDepth?: number;
```

`defaultModel.ts` — seed `dimension: '2d'`, `gridDepth: 1` in `properties`, and a top-level `topologyMode: { gridCells: true, agents: false }`. Leave `topology: '2d-grid'` untouched.

`ModelContext.tsx` — clone the `UPDATE_VARIEGATED_CELLS` shape:
```ts
// action union (:192)
| { type: 'UPDATE_TOPOLOGY_MODE'; changes: Partial<TopologyMode> }

// reducer, right after UPDATE_VARIEGATED_CELLS (:900)
case 'UPDATE_TOPOLOGY_MODE': {
  const current = state.model.topologyMode ?? { gridCells: true, agents: false };
  const next = { ...current, ...action.changes };
  if (!next.gridCells && !next.agents) return state;   // reject all-false (defense-in-depth)
  return { ...state, isDirty: true, model: { ...state.model, topologyMode: next } };
}

// LOAD_MODEL migration guards (:710 region, beside the existing additive guards)
if (!m.properties.dimension) m.properties.dimension = '2d';
if (m.properties.gridDepth === undefined) m.properties.gridDepth = 1;
if (!m.topologyMode) m.topologyMode = { gridCells: true, agents: false };

// ModelContextValue interface (:1044): updateTopologyMode: (changes: Partial<TopologyMode>) => void;
// callback (:1244): const updateTopologyMode = useCallback((changes) => dispatch({type:'UPDATE_TOPOLOGY_MODE', changes}), []);
// value object (:1311) AND useMemo deps (:1357): add updateTopologyMode to BOTH (miss either → stale closure)
```

`PropertiesPanelContent.tsx` — two new clusters cloning the verbatim templates:
- **Dimension radio** inside the Structure section (after the Grid W/H `fieldRow`): clone the Compile-Target radio shape (`<div style={{marginTop:14, borderTop:'1px solid #333', paddingTop:10}}>` + `.fieldLabel` 'Dimension' + two `name="dimension"` radios `2d`/`3d` → `updateProperties({dimension})`). When 3D, render a **Grid Depth** `NumberField` (clone of Grid Height at `:119-128`, `min 1`, `integer`, → `updateProperties({gridDepth:n})`). Add a `#888 0.66rem` description.
- **Topology checkboxes** in the Execution section, ABOVE the Variegated cluster: clone the Variegated checkbox wrapper. Grid Cells `checked={topo.gridCells} disabled={topo.gridCells && !topo.agents}` → `updateTopologyMode({gridCells})`. Bond-Graph Agents: **hard `disabled={true}` this milestone** + `title="Coming soon — the agent rule graph is not yet available"`. Use `const topo = model.topologyMode ?? {gridCells:true, agents:false};`. Mirror the `disabled`+`opacity:0.55`+`cursor:'not-allowed'` style from `:157-165`.
- Extend `isSpatialIndicator` (`:44-45`) to include `'layers'`.

**Before → after (Execution panel).**
```
BEFORE:  [Update Mode]  [Compile Target]  [Variegated Cells ☐]
AFTER:   ...Structure: [Boundary] [W][H]  +Dimension(◉2D ○3D)[+Depth when 3D]
         Execution: [Update Mode] [Compile Target] +Topology(☑Grid Cells ☐Bond-Graph Agents[disabled]) [Variegated Cells ☐]
```

**Acceptance test.** (1) `npx tsc -b` clean. (2) In `npm run dev`, load every `public/models/*.gcaproj`; via `preview_eval` read `useModel().model` (or inspect through a DEV hook) and assert each gets `topologyMode` deep-equal `{gridCells:true, agents:false}`, `properties.dimension==='2d'`, `properties.gridDepth===1` (none ship these fields → migration fires). (3) Toggling Dimension → 3D shows the Grid Depth field. (4) Unchecking Grid Cells while Agents is off: the checkbox is `disabled` (greyed). (5) **Cross-target byte-identity** (the regression guard): compile Game-of-Life BEFORE and AFTER the schema additions; assert `.stepCode`/`.bytes`/`.shaderCode` byte-identical — proves M0a fields are inert for the compilers.

**Risk/lockstep note.** Pure plumbing, no compiler emit change. The one trap is the **dep-array double-wiring** (`updateTopologyMode` in BOTH the value object and the useMemo deps) and the **naming collision** (`topologyMode`, never `topology`). Per CLAUDE.md, ship the HTML mockup of the Execution panel alongside this PR, and update HelpView/README.

---

### PR2 — Worker 3D engine (JS) + 3D-Life sample model

> ⚠️ **Per §0.5 B1, PR2 and PR3 MUST merge as ONE PR** — the worker arg-builders (here) and the compiler param-lists (PR3) are two halves of one positional ABI; shipping PR2 alone corrupts every JS model. Also apply §0.5's PR2 amendments (3-ify the `paint`/`writeRegion` handlers; InitEvent `z`/`maxZ` ports if you emit the `_layer` decode). The acceptance test must run the **compiled** 3D-Life step end-to-end, not just the offset table.

**Goal.** Make the worker compute `total = W*H*D`, build a 3D neighbour-offset table from 3-tuple coords, and thread `depth` through the init message + worker args. Add a totalistic 3D-Life sample model so the engine is **headless-verifiable via `getState` with no renderer**.

**Files & symbols.**
- `src/simulator/engine/sim.worker.ts:281-283` (`let width/height/total`), `:751` (`initGrid` total), `:877-913` (`buildNeighborIndices`), `:938` (`buildLoopArgs`), `~:967` (`buildCellArgs`), `:2337-2338` (`init` handler), the `InitMsg`/neighbourhood-payload types (≈ `:78-79`/`:199-200`).
- `src/simulator/SimulatorView.tsx:1689-1690` (init message `width/height`), `:1700` (neighborhoods map), `:1617-1619` (`dimsModel` override).

**The change.**

`sim.worker.ts`:
```ts
// :282  add module var
let depth = 1;

// :2337-2338  init handler, after height = msg.height;
depth = (msg as { depth?: number }).depth ?? 1;

// :751  initGrid
total = width * height * depth;   // was width * height

// :877-913  buildNeighborIndices — 3-ify the loop (stride UNCHANGED)
for (let layer = 0; layer < depth; layer++)
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const cellIdx = (layer*height + row)*width + col;
      for (let n = 0; n < nbrSize; n++) {
        const c = nbr.coords3d ? nbr.coords3d[n]! : nbr.coords[n]!;
        const dr = c[0], dc = c[1], dl = (c as number[])[2] ?? 0;
        let nL = layer+dl, nR = row+dr, nC = col+dc;
        if (nL<0||nL>=depth||nR<0||nR>=height||nC<0||nC>=width) {
          if (boundaryTreatment === 'torus') {
            nL = ((nL%depth)+depth)%depth; nR = ((nR%height)+height)%height; nC = ((nC%width)+width)%width;
          } else { indices[cellIdx*nbrSize+n] = total; continue; }   // sentinel unchanged
        }
        indices[cellIdx*nbrSize+n] = (nL*height + nR)*width + nC;
      }
    }
// nbrSize = nbr.coords3d?.length ?? nbr.coords.length;  stride stays coords.length — every consumer byte-compatible
```
- `buildLoopArgs` (`:938`): `const args = [total, width, height, depth, width*height]` (add `D`, `WH`).
- `buildCellArgs` (`~:967`): append `, depth, width*height`. The OutputMapping/Init arg builder must mirror the compiler's param order exactly (`total, W, H, D, WH`).
- Add `depth?: number` to the `InitMsg` type and `coords3d?: Array<[number,number,number]>` to the neighbourhood-payload type, or `tsc` fails on `msg.depth` / `n.coords3d`.

`SimulatorView.tsx`:
- `:1689-1690` init message: add `depth: model.properties.dimension === '3d' ? (model.properties.gridDepth ?? 1) : 1,` after `height: h`.
- `:1700` neighborhoods map: carry `coords3d` → `effModel.neighborhoods.map(n => ({ id: n.id, coords: n.coords, coords3d: n.coords3d }))`.
- `:1617-1619` `dimsModel`: confirm `gridDepth` survives the `{...effModel.properties}` spread (it does — no change needed unless a depth-resize is added later).

**Sample model.** Add a script `scripts/gen-life3d.mjs` (mirror `gen-grayscott.mjs`) that builds `public/models/Life3D.gcaproj`: `dimension:'3d'`, e.g. `8×8×8`, `torus`, a 26-cell Moore-3D neighbourhood (`coords3d` = all `[dr,dc,dl]` with each in `{-1,0,1}` minus the origin), and a Bays 5766 rule (`B5/S567`) via `getNeighborsAttribute → aggregate.sum → compare`. Seed a small known live pattern.

**Acceptance test.** (1) `tsc -b` clean. (2) **3D offset-table correctness** (`getState`): load a 3D model with a torus von-Neumann-6 neighbourhood; after init, independently recompute `(((z+dl+D)%D)*H + ((y+dr+H)%H))*W + ((x+dc+W)%W)` for every cell and assert 0 mismatches against the resolved table; assert `total === W*H*D`; for constant boundary, OOB neighbours resolve to the sentinel `total`. (3) **3D-Life evolves**: seed the known pattern, step N gens on JS, capture live-cell count + per-layer histogram via `getState`, and check it matches a hand-computed expectation for the deterministic totalistic rule. (4) **2D regression**: a 2D model's neighbour table + step output unchanged (the `depth===1` / no-`coords3d` path is byte-identical by construction).

**Risk/lockstep note.** JS-only this PR (the JS step reads `total` as a runtime arg — free). The trap is the **stride invariant**: do NOT change the `nIdx_<nbr>[idx*nSz+k]` consumer arithmetic — only the *loop that fills the table* gains a dimension. Constant-boundary must bounds-check all 3 axes (`nL<0||nL>=depth`) or 3D faces corrupt to a wrong in-range cell. `total = W*H` stays the 2D fast path automatically (`depth===1`).

---

### PR3 — JS compiler 3D decode  ·  ⚠️ merge with PR2 (§0.5 B1)

> **This is the other half of the PR2 ABI — merge them as one PR.** The `_row`/`_col` decode is emitted at **multiple sites** (compile.ts ~1721/1725-1726 async-step, ~1749/1751-1752 sync-step, ~1795-1798 InputColor, ~1843-1846 OutputMapping, ~1885-1891 InitEvent) — the 3D `_layer` decode must land at **every** one, each gated on `gridDepth===1` for byte-identical 2D.

**Goal.** Emit the 3D per-cell coordinate decode in the JS-compiled step (and InputColor/OutputMapping/InitEvent), gated so `gridDepth===1` emits the verbatim current 2-line decode.

**Files & symbols.** `src/modeler/vpl/compiler/compile.ts`: `buildLoopParams` (`:1145`), `buildCellParams` (`:1170`), OutputMapping `omParamParts` (`:1819`), and the decode at five sites — async step (`:1725-1726`), sync step (`:1751-1752`), InputColor (`:1797-1798`), OutputMapping (`:1845-1846`), InitEvent (`:1886-1891`).

**The change.**
```ts
// param lists — add D, WH (WH = W*H precomputed to avoid per-cell recompute)
buildLoopParams: ['total','W','H']        → ['total','W','H','D','WH']   // :1145
buildCellParams: ['idx','total','W','H']  → ['idx','total','W','H','D','WH']   // :1170
omParamParts:    ['total','W','H']        → ['total','W','H','D','WH']   // :1819

// compute once near the top of compileGraph:
const is3d = (model.properties.gridDepth ?? 1) > 1;
const decodeLines = is3d
  ? ['const _layer=(idx/WH)|0;', 'const _rem=idx-_layer*WH;', 'const _row=(_rem/W)|0;', 'const _col=_rem-_row*W;']
  : ['const _row=(idx/W)|0;', 'const _col=idx-_row*W;'];   // VERBATIM current → zero 2D regression
```
Replace the 2-line decode at all five sites with `...decodeLines`. **Do NOT rename `_row`/`_col`** (NI/sub-attr nodes read them). InitEvent (`:1888-1891`): after the existing x/y/maxX/maxY lines, gated on `is3d`, add `const _v${initId}_z = _layer; const _v${initId}_maxZ = D - 1;` (exposing `z`/`maxZ` ports on `InitEventNode` is optional this milestone — the decode is the load-bearing part).

**Before → after (sync-step preamble).**
```
BEFORE:  const _row=(idx/W)|0;  const _col=idx-_row*W;
AFTER (3D):  const _layer=(idx/WH)|0;  const _rem=idx-_layer*WH;  const _row=(_rem/W)|0;  const _col=_rem-_row*W;
AFTER (2D):  (unchanged)
```

**Acceptance test.** (1) `tsc -b` clean. (2) Via the compiler-import harness: a 4×4×4 model's `js.stepCode` contains `_layer=(idx/WH)|0` and `_rem=idx-_layer*WH`; a 2D model's `js.stepCode` is string-identical to the pre-change baseline. (3) End-to-end: the PR2 3D-Life model now runs through the compiled step (not just the offset table) and `getState` matches the same hand-computed trajectory.

**Risk/lockstep note.** JS-only; WASM/WebGPU decode lands in PR5/PR6. The arg order in `sim.worker.ts` `buildLoopArgs`/`buildCellArgs` (PR2) MUST match these param lists exactly (`total, W, H, D, WH`) — a mismatch silently passes the wrong values.

---

### PR4 — 3D neighbourhood schema + parametric generators + slice-stack editor + gate tags/picking

**Goal.** Make neighbourhood editing 3D: add `coords3d?` + a `shape?` spec to the schema, a pure `generateCoords3d(spec)` materializer driving a parametric named-shape panel (primary), a 2D-slice-stack editor (hand-tuning + per-slice tags), and gate the 2-axis `neighborIndex` family + picker off in 3D.

**Files & symbols.**
- `src/model/types.ts:95` (`Neighborhood.coords`).
- `src/modeler/panels/NeighborhoodsPanelContent.tsx:64-65` (`expandSymmetry` diagonal mirrors), `:75-91` (`annulusCells`), `:75-185` (`lineCells`/`shapeCells`/`applyCellsChanges` — the 2D editor to reuse).
- `src/modeler/vpl/types.ts:76-93` (`NodeRequirements`), `src/modeler/vpl/nodes/nodeValidation.ts:459-464` (`isNodeAvailable`).
- The `neighborIndex` family: `GetNeighborAttributeByIndexNode`, `SetNeighborAttributeByIndexNode`, the `neighborIndex` value type, and the `NeighborIndexValuePicker` widget.

**The change.**
```ts
// types.ts:95  — additive, old 2D files load unchanged
coords3d?: Array<[number, number, number]>;   // presence = a 3D neighbourhood; entries [dr,dc,dl]
shape?: NeighborhoodShapeSpec;                 // drives the parametric editor + re-tune
type NeighborhoodShapeSpec =
  | { kind:'moore'|'vonNeumann'|'ball'|'rangeN', radius:number, metric?:'chebyshev'|'manhattan'|'euclidean' }
  | { kind:'shell', rIn:number, rOut:number }
  | { kind:'ring'|'disk', axis:'x'|'y'|'z', radius:number, width?:number };
```
- New pure module (e.g. `src/modeler/panels/neighborhood3d.ts`): `generateCoords3d(spec): Array<[number,number,number]>` — one extra loop over `layer` in the `annulusCells` style. Store **both** the spec AND the materialized `coords3d` (coords is the runtime source of truth); a cascade re-materializes on spec edit (mirror the `linkedOutputMappings` cascade — never let a stale spec emit a dangling read).
- **Parametric panel (primary):** dropdown of `kind` + `radius`/`axis`/`metric` inputs → `generateCoords3d` → `updateNeighborhood({coords3d, shape})`. Expose `metric` so one dropdown reproduces Moore (L∞) / von Neumann (L1) / sphere (L2); document the mapping in-app.
- **Slice-stack editor (secondary):** reuse the 2D grid editor verbatim + a Z-slice `±margin` stepper; each slice edits `(dr,dc)` at fixed `dl`. Per-index **tags** are offered ONLY here (right-click-a-cell per slice). Restrict 3D symmetry to the three axis-plane mirrors (H/V + a new "L" layer mirror) — **do NOT port the D/D2 diagonal mirrors** (`:64-65`), they don't generalize to 3D.
- **Gate the 2-axis family in 3D:** add `lattice2d?: boolean` to `NodeRequirements`; set it on the `neighborIndex` value type + `GetNeighborAttributeByIndex`/`SetNeighborAttributeByIndex`; extend `isNodeAvailable` so these are hidden when `dimension==='3d'`. `GetNeighborAttributeByTag` is the 3D substitute (dimension-agnostic — resolves a flat coord index).

**Acceptance test.** (1) `tsc -b` clean. (2) Unit: `generateCoords3d({kind:'vonNeumann', radius:1})` returns exactly the 6 cardinal 3-tuples; `{kind:'moore', radius:1}` returns 26; `{kind:'ball', radius:2, metric:'euclidean'}` matches an independent Euclidean enumeration. (3) Round-trip: pick a parametric shape, save `.gcaproj`, reload → `coords3d` + `shape` survive (depends on PR9 serialize, or test in-memory). (4) Gating: in a 3D model the palette / add-node menu does NOT offer `GetNeighborAttributeByIndex` or the `neighborIndex` value type; a 2D model is unaffected. (5) Slice editor: editing slice `dl=+1` adds `(dr,dc,+1)` tuples; tagging a cell in a slice persists.

**Risk/lockstep note.** No compiler emit change (the offset-table loop from PR2 already consumes `coords3d`). The trap is the **spec/coords desync** ([PLAN R7](PLAN_BG_DIMENSIONS_AND_MODES.md)) — re-materialize on spec edit. Per CLAUDE.md, ship an HTML mockup of the parametric + slice editor.

---

### PR5 — WASM 3D port (lockstep)

**Goal.** Port the 3D engine to WASM: `total = W*H*D` in the layout, the depth-gated 3-decode in `emitBody`, InitEvent `z`/`maxZ`. Leave the 2-axis NI path (`pushNiCellIdx`) and the variegated facing emitters 2D-gated.

**Files & symbols.**
- `src/modeler/vpl/compiler/wasm/layout.ts:194` (`computeMemoryLayout(total, …)`), `:412` (`computeLayoutFromModel` total), the `MemoryLayout` interface + return block.
- `src/modeler/vpl/compiler/wasm/compile.ts:6562-6571` (`emitBody` row/col decode), `:6385-6386` (local alloc), `:6417-6418` (`rowLocalIdx`/`colLocalIdx` ctx fields), `:6452` (`W = gridWidth`), `:2054-2068` (`getSelfPosition`/InitEvent), `:328-377` (`pushNiCellIdx` — 2D NI, **leave**), `:1699+/:1846+/:4650+/:5588+` (variegated facing emitters — **leave**).

**The change.**
- `layout.ts:412`: `const total = gridWidth * gridHeight * (gridDepth ?? 1);`. Add `gridDepth: number` to `MemoryLayout` and set it (derive `const gridDepth = Math.max(1, model.properties.gridDepth ?? 1)`). `computeMemoryLayout` keeps its `total` param — no signature change; every region is `total`/`cellsPerAttr`-sized (dimension-agnostic). Derive depth in the emitter from `ctx.model.properties.gridDepth ?? 1` to minimize layout-signature churn.
- `compile.ts` `emitBody` (`:6562-6571`): gate on `const D = model.properties.gridDepth ?? 1; const WH = W*H;`. When `D===1` keep the current `row=idx/W; col=idx-row*W` two-block emit **byte-identical**. When `D>1`, alloc `layerLocal`/`remLocal` and emit `layer = idx / WH` (`i32Const(WH)`, `DIV_S` → layerLocal), `rem = idx - layer*WH`, `row = rem / W`, `col = rem - row*W`. Add `layerLocalIdx` to `WasmCompileCtx` only if a 3D-aware emitter needs the layer (for pure totalistic rules, `rowLocal`/`colLocal` suffice).
- `getSelfPosition`/InitEvent (`:2054-2068`): when `D>1`, x/y/maxX/maxY unchanged; add `z=layerLocal`, `maxZ=D-1` cached ports if InitEvent exposes them.

**Acceptance test.** (1) `tsc -b` clean. (2) Compiler-import harness: `computeLayoutFromModel(m).total === 64` for a 4³ grid; `compileGraphWasm` returns no errors, `bytes.length > 0`. (3) **JS↔WASM exact parity**: the PR2 3D-Life model from the same seed produces an identical live-cell count + per-layer histogram on JS and WASM at gen N (deterministic integer totalistic rule → bit-identical). (4) **2D byte-identity**: an existing model's `wa.bytes` is byte-equal to the pre-change baseline (`Array.from(bytes).join()`).

**Risk/lockstep note.** WASM bakes geometry as compile-time literals — this is real lockstep work, not the free arg-pass JS gets. `pushNiCellIdx` (2-axis NI) and the facing emitters stay 2D — they only fire for 2D-gated models. The 2D byte-identity test is the regression guard.

---

### PR6 — WebGPU 3D port (lockstep)

**Goal.** Port the 3D engine to WebGPU: `total = W*H*D` in the layout, the 3D `nbrCellIdx` WGSL helper gated on `gridDepth`, the per-cell row/col decode via `WH`, the 3-stride neighbour-offset upload. Dispatch is already `total`-keyed.

**Files & symbols.**
- `src/modeler/vpl/compiler/webgpu/layout.ts:151-157` (`gridWidth/gridHeight/total/cellsPerAttr/sentinelIndex`), `:292-295` (`WebGPULayout` return), and `nbrBytes` sizing.
- `src/modeler/vpl/compiler/webgpu/encoder.ts:57-104` (`nbrCellIdx`/`nbrCellIdxFromNi` in `emitBindings`), `:150-158` (`emitEntryPoint` bounds `idx >= ${total}u`).
- `src/modeler/vpl/compiler/webgpu/compile.ts:1196-1197,:1983-1984,:2077-2078` (row/col `i32(idx/${W}u)`), `:2167-2168` (InitEvent).
- `src/simulator/engine/webgpuRuntime.ts` `uploadNeighborOffsets`, `:919` (`dispatchStep`), `:944` (`dispatchInit`).

**The change.**
- `layout.ts:151-157`: `const gridDepth = Math.max(1, model.properties.gridDepth || 1); const total = gridWidth * gridHeight * gridDepth;`. Add `gridDepth: number` to `WebGPULayout` + the return block. `sentinelIndex`/`cellsPerAttr` stay `total`-keyed (correct for 3D). **`nbrBytes` stride becomes 3 i32/neighbour (dr,dc,dl) when any neighbourhood is 3D** (gate on `coords3d` presence; 2D stays 2-stride).
- `encoder.ts:57-104`: bake `const gd = layout.gridDepth; const wh = gw*gh;`. When `gd>1`, rewrite both `nbrCellIdx`/`nbrCellIdxFromNi` to 3D: decode `let layer = i32(cellIdx)/${wh}; let rem = i32(cellIdx)-layer*${wh}; let row = rem/${gw}; let col = rem%${gw};`, read the **third** offset `let dl = nbrOffsets[baseOffset + u32(k)*3u + 2u]` (stride `*3u`), torus `let nl = ((layer+dl)%${gd}+${gd})%${gd};`, `return (nl*${gh}+nr)*${gw}+nc;`; constant adds `|| layer+dl < 0 || layer+dl >= ${gd}` to the OOB test returning `${layout.sentinelIndex}`. **Gate on `gd`:** `gd===1` emits the EXACT current 2-tuple-stride helpers byte-identical (zero regression, pipeline cache unaffected).
- `compile.ts` row/col (`:1196-1197` etc.): when `gd>1`, `rowExpr = i32((idx % ${WH}u) / ${W}u)`, `colExpr = i32(idx % ${W}u)` (2D reduces to `idx/W` — emit the simpler form when `gd===1` for byte-identity). InitEvent (`:2167-2168`): add `init_z = i32(idx / ${WH}u)`, `init_mz = ${gd-1}` when 3D.
- `webgpuRuntime.ts`: `uploadNeighborOffsets` packs **3 i32 (dr,dc,dl)** per neighbour when the neighbourhood has `coords3d` (matching the encoder's `*3u`); `dispatchStep`/`dispatchInit` already use `Math.ceil(rt.layout.total / WORKGROUP_SIZE)` — no change (total is now `W*H*D`).

**Acceptance test.** (1) `tsc -b` clean. (2) Compiler-import harness: a 4³ model's `wg.shaderCode` includes `idx >= 64u` and `nbrCellIdx` contains the `${wh}` decode + the `nl*` term. (3) 3D-Life renders/evolves on WebGPU with the same live-cell trajectory as JS/WASM (integer totalistic → f32 path is exact here). (4) **2D byte-identity**: an existing model's `wg.shaderCode` is string-identical to the pre-change baseline (pipeline cache `shaderHashOf` unaffected).

**Risk/lockstep note.** The **nbrOffsets stride change is the one runtime upload that changes shape in 3D** — a mismatch between the encoder's `*3u` and `uploadNeighborOffsets` silently reads garbage offsets. A stale baked `total` is the documented Resize-bug class (only the first `W*H` cells of a `W*H*D` buffer evolve) — confirm `gridDepth` reaches `compileGraphWebGPU` via the `dimsModel` properties spread.

---

### PR7 — RGBA authorable alpha (3 targets + WebGPU alphaMode)

**Goal.** Unpin `colors[idx+3]=255`; route an authored alpha through Set Cell Looks + the colour-mapping nodes on all 3 targets; flip the WebGPU canvas `alphaMode` so it stops discarding alpha. Default stays 255 everywhere → existing models byte-identical.

**Files & symbols.**
- `src/modeler/vpl/nodes/SetCellLooksNode.ts:50` (after `glyphB` port), `:65` (`colors[colorIdx+3]=255`).
- `src/modeler/vpl/compiler/wasm/compile.ts:5062-5064` (`i32Const(255); i32Store8(+3)`).
- `src/modeler/vpl/compiler/webgpu/compile.ts:2706-2709` (`| (255u<<24u)`).
- `src/simulator/engine/sim.worker.ts:1715` (`writeDefaultColors` fallback), `src/simulator/engine/SimEngine.ts:189,227` (reference-only).
- `src/modeler/vpl/nodes/ColorScaleNode.ts:41-43`, `CategoricalColorNode.ts:44-46` (the `r`/`g`/`b` outputs).
- `src/simulator/engine/webgpuRuntime.ts:493-497` (present shader unpack), `:516` (`alphaMode:'opaque'`).

**The change.**
- **Set Cell Looks `a` input port** (after `glyphB`, `inlineWidget:'number'`, `defaultValue:'255'`):
  ```js
  // JS [:65]   was: colors[colorIdx+3] = 255;
  colors[colorIdx+3] = ${inputs['a'] || '255'};
  // WASM [:5062-5064]   replace i32Const(255) with pushValueAs(inputs['a'] ?? 255), clamp 0..255
  // WebGPU [:2709]      replace (255u<<24u) with ((u32(clamp(<a>,0,255)))<<24u)
  ```
- **Color Scale + Categorical Color gain an `a` OUTPUT channel** — a fourth `_v${id}_a` variable (per-stop for Color Scale, per-entry `entry_${i}_a` for Categorical, default 255). This needs the **full multi-output registration**: `MULTI_OUTPUT_TYPES`, a `varName()` special-case, and WASM/WebGPU `setCachedPort('a', …)` — or downstream references an undeclared `_v${id}_a` (CLAUDE.md varName discipline).
- **WebGPU canvas:** flip `alphaMode:'opaque'` → `'premultiplied'` (`:516`) and premultiply in the present shader (`vec4(r*a, g*a, b*a, a)`), so all three targets render translucency identically (lockstep forbids a cross-target visual divergence). Gate behind the see-through state if you ship the global slider here.
- Default 255 at the inline widget + every `|| '255'` / `?? 255` fallback. (The 2D renderer already composites alpha — `clearRect` at `:788` leaves the canvas transparent + `drawImage` is source-over — so a non-255 alpha shows through with no 2D renderer change.)

**Acceptance test.** (1) `tsc -b` clean. (2) **Byte-identity with alpha=255** (the critical regression): compile an unchanged model before/after; assert `.stepCode`/`.bytes`/`.shaderCode` byte-identical (the inline-255 default must emit the same code). (3) A model authored with sub-255 alpha on Set Cell Looks: the 2D canvas shows the cell translucent against the page (visual `preview_eval` / screenshot). (4) WebGPU: with `alphaMode` flipped, the same model renders translucent (not opaque-black).

**Risk/lockstep note.** Alpha-default drift is the hazard — any non-255 default silently darkens every existing model ([PLAN R4](PLAN_BG_DIMENSIONS_AND_MODES.md)). The multi-output `a` channel on Color Scale / Categorical Color is the easy-to-get-wrong part (forget the `varName()` case → undeclared variable). Thumbnails composite translucent frames against the card background — force thumbnail capture opaque or document it ([PLAN R8](PLAN_BG_DIMENSIONS_AND_MODES.md)).

---

### PR8 — WebGL2 3D renderer

**Goal.** Build the WebGL2 voxel renderer behind a `draw()` seam branch on `dimension==='3d'`: instanced cubes from the RGBA colors buffer, orbit camera, a clip/slice plane (PRIMARY see-inside), opt-in per-cell alpha, GPU colour-id picking, display-canvas recording/screenshot. Sub-sliced into six commits.

**Files & symbols.**
- NEW `src/simulator/render/gl3d.ts`.
- `src/simulator/SimulatorView.tsx`: `draw()` (`:743-1078`, a `useCallback([])` called from ~20 sites), the guard at `:748`, the 2D blit at `:754,780-784,788,919,923`, `colorsRef` (`:605`, set at `:1196`), the canvas JSX (`:3891`), the canvas-mousedown effect (`~:2640`), `screenToGrid` (`:2320-2342`), the recording block (`:1308-1335`), `handleScreenshot` (`:3232-3262`), the zoom-controls overlay (`:4047-4073`), `data-sim-overlay` early-return (`:2655`).

**The change.** A `Gl3DRenderer` class with: `gl = canvas.getContext('webgl2', {antialias:true, alpha:true, preserveDrawingBuffer:true})`; a unit-cube VBO; per-instance attributes via `gl.vertexAttribDivisor`; **instance culling** (scan `colors` for alpha>0 cells into a compacted instance buffer — NEVER instance the full `W*H*D` volume; 256³=16.7M is fatal); vertex shader decodes x/y/z from the grid index + `uW/uH/uD`; fragment shader does the clip-plane `discard` + flat-shades by face normal; `pick(px,py)` via a second colour-id FBO pass (encode `idx` as RGB, depth-test so the nearest cube wins, `gl.readPixels` with Y-flip `H-py`).

SimulatorView wiring (read `is3D`/camera/clip/`gridDepth` via **refs** — `draw()` is `useCallback([])` and ~20 call sites depend on the empty dep array):
```ts
const is3D = (model.properties.dimension ?? '2d') === '3d';   // + an is3dRef mirror
const glCanvasRef = useRef<HTMLCanvasElement>(null);
const gl3dRef = useRef<Gl3DRenderer|null>(null);
const cam3dRef = useRef({ yaw:0.6, pitch:0.5, dist:2.5, panX:0, panY:0 });
// JSX (:3891): a sibling <canvas ref={glCanvasRef}> shown when is3D, the 2D canvas hidden when is3D
// draw() top branch (after :748 guard): if (is3dRef.current) { resize+uploadColors+setCamera+setClipPlane+render; return; }
// init/dispose effect on [is3D]; persist camera in genesisca_sim_settings
```

**Six commits (each independently verifiable):**
1. **Static cube render** — instanced unit-cube pipeline, culling, colour-per-instance from `colorsRef`, hardcoded iso projection, the GL canvas + `is3D` gating + `draw()` branch + init/dispose. *Riskiest/most-foundational — get the seam + colours + culling right first.*
2. **Orbit/trackball camera** — `setCamera` + perspective + LMB-drag orbit / wheel zoom / MMB+Shift pan in the pointer handlers' 3D branch (keep the `data-sim-overlay` early-return). Persist camera.
3. **Clip/slice plane (PRIMARY see-inside)** — fragment `discard` past a bounded plane + an X/Y/Z axis toggle + slider in the zoom-controls overlay, as a **bounded model attribute** (live-tunable). This is the cheap, correct, industry-norm reveal ([PLAN §8.4, D2](PLAN_BG_DIMENSIONS_AND_MODES.md)) — NOT depth-sort.
4. **Per-cell alpha (opt-in blend)** — `setAlphaBlend(on)` enables GL blend + CPU back-to-front instance sort (Option A, opt-in, NEVER the default). Reads the alpha byte (alpha=0 already culled). Depends on PR7 for non-trivial authored alpha.
5. **GPU colour-id picking** — the pick FBO + decode + branch the paint/inspect/line handlers to `pick()` when 3D (feed the same flat `idx` to the index-keyed protocol). Decode `idx → {layer,row,col}` for the worker paint message. Brush stamps are 2D — **3D v1 paints a single cell (radius-1); hide the brush-shape UI when 3D**.
6. **Recording + screenshot via display-canvas readback** — `preserveDrawingBuffer:true` + `gl.readPixels` in the recording capture block (`:1308-1335`) and `handleScreenshot` (`:3232`). This changes resolution semantics (display-res, not grid-res) — document it; the WebM/GIF encoders take arbitrary ImageData sizes.

**Acceptance test.** Add DEV hooks `window.__sim3dCamera/__sim3dPick/__sim3dClip` (synthetic pointer events don't drive canvas drags — mirror `window.__simWorker`). (1) **Orbit changes pixels**: screenshot, bump `cam3dRef.current.yaw`, screenshot, assert non-trivial pixel delta. (2) **Clip hides front**: fully-occupied grid, screenshot; set clip mid-range, screenshot, assert interior now visible (background-pixel count up); disable → returns to the full-volume screenshot. (3) **Pick returns a cell id**: distinct-coloured cell at known `(x,y,z)`, set camera, compute its screen centre, `window.__sim3dPick(cx,cy)` returns `idx===(z*H+y)*W+x`; empty background returns -1; Shift+LMB opens the inspector for the right cell. (4) **Colours upload**: `gl3dRef.current.instanceCount` equals the alpha>0 cell count in `colorsRef`. (5) **Recording/screenshot non-empty**: 3 frames captured at GL canvas *display* size (not grid size); screenshot produces a non-zero PNG. (6) **No 2D regression**: a 2D model has `is3D===false`, GL canvas `display:none`, the 2D blit path unchanged.

**Risk/lockstep note.** `draw()` must NOT gain reactive deps (read everything via refs). You **cannot** `getContext('webgl2')` on the existing 2D canvas — a separate GL `<canvas>` sibling is mandatory. **3D v1 runs JS/WASM only** for rendering: under WebGPU *direct* render the worker skips the colors buffer (`sim.worker.ts:2301-2311`) and the GL renderer has nothing to upload — force the colors-transfer path or have the worker always ship colors when `is3D`. `gl.readPixels` is bottom-left origin (flip Y). Screenshot needs `preserveDrawingBuffer:true` or a re-render before readback.

---

### PR9 — Save/load + indicators + inspector 3D consumer-scan

**Goal.** Round-trip `dimension`+`gridDepth`+`depth` through `.gcaproj`/`.gcastate`, extend dim-validation to depth, add the spatial-indicator `'layers'` axis, and document the deferred neighborIndex 3rd-offset decision in the inspector.

**Files & symbols.**
- `src/model/fileOperations.ts:153-192` (`stringifyCompact`), `:383-386` (`ATTR_TYPE_MAP` — **no change**, 3D arrays are longer but same element type), `:388-466` (`serializeSimState`), `:471-520` (`serializePreset`), `:526-544` (`readStateFile`).
- `src/simulator/SimulatorView.tsx:3411-3415,:3420-3424,:3484` (`applySimulationState` dim-check), `:3350-3360` (`handleLoadPreset`), the `gridWidth`/`gridHeight` refs (add a `gridDepth` ref).
- `src/simulator/engine/sim.worker.ts:2087-2200` (`computeSpatialIndicators`), the getState payload.
- `src/simulator/IndicatorSpatialChart.tsx:15,:118` (`axis`/`axisName`).
- `src/simulator/InspectCellPopover.tsx:62-67` (`neighborIndex` decode — **no functional change**).

**The change.**
- **Serialize** (`fileOperations.ts`): the `workerState` shape gains `depth: number`; write `serialized.gridDepth = workerState.depth` (beside `gridWidth/gridHeight`) and `serialized.depth = workerState.depth` inside `wantGrid` (beside `width/height`); same in `serializePreset`. `readStateFile` normalizes `if (state.depth === undefined) state.depth = 1;`. **No `ATTR_TYPE_MAP` change** — a longer buffer base64's automatically.
- **Dim-validation** (`SimulatorView.tsx`): add a `gridDepth` ref synced wherever `gridWidth.current`/`gridHeight.current` are set (init, resize, applySimulationState). Extend `dimsFromState` to carry `d: state.gridDepth ?? state.depth ?? 1`, `dimsChanged` to test depth, and the hard validation (`:3484`) to reject `(state.depth ?? 1) !== (gridDepth.current ?? 1)` with a `×D` message (show the 3rd dim only when either is >1).
- **Spatial `'layers'`** (`computeSpatialIndicators`, `:2087-2200`): accept `def.xAxis === 'layers'`; `axisLen = depth`; `posBin` decodes `layer = Math.floor(i/(W*H))` and selects `pos = layers ? layer : rows ? row : col`. `IndicatorSpatialChart.tsx`: widen `axis` to include `'layers'`, `axisName = 'layer'`. The IndicatorsPanelSection X-axis dropdown offers `'layers'` only when `dimension==='3d'`. Extend the other `isSpatial` checks (`sim.worker.ts:1203,1505,2090`; `PropertiesPanelContent.isSpatialIndicator`).
- **Inspector** (`InspectCellPopover.tsx:62-67`): **no functional change** — the 3rd (dl) offset requires the deferred NI codec redesign ([PLAN §6.5](PLAN_BG_DIMENSIONS_AND_MODES.md)). Leave `(dr ${dr}, dc ${dc})`; add a TODO comment at `:66` pointing to the NI-codec milestone so the consumer-scan is provably complete. **Do not invent a fake `dl`.**

**Acceptance test.** (1) `tsc -b` clean. (2) Save a `dimension:'3d', gridDepth:8` model → the `.gcaproj` text contains `"dimension": "3d"`, `"gridDepth": 8`, `"topologyMode"`; reload → fields survive. A legacy file with no `gridDepth` still loads (the PR1 migration test). (3) A `.gcastate` saved at `depth:8` loaded into a depth-1 grid surfaces the new mismatch error with `×8`; a matching depth-1 state restores with no error. (4) Spatial `'layers'`: with a synthetic `readAttrs` at a hand-set depth, per-bin series for `xAxis='layers'` match an independent re-bin by `Math.floor(i/(W*H))`, sum-of-bins === per-value total, 0 mismatches; `depth===1` → a single bin. (5) Inspector unchanged on 2D neighborIndex attributes (`(dr X, dc Y)`, no fake `dl`).

**Risk/lockstep note.** The **`gridDepth` ref must stay in lockstep** with `gridWidth.current`/`gridHeight.current` at EVERY assignment site, or depth validation reads stale and falsely accepts/rejects. `ATTR_TYPE_MAP` needs no new entry (the CLAUDE.md warning is about new *types*, not new *lengths*). The `'layers'` enum value is the minimal symmetric extension of `rows`/`columns` — `IndicatorSpatialChart` already parameterizes on `axisName`.

---

## §3 — Cross-cutting gotchas

1. **The lockstep verification harness is your primary regression guard.** For every compiler-touching PR (PR3, PR5, PR6, PR7), run the cross-target compiler-import check (§0.4b) on an UNCHANGED 2D model before and after — `.stepCode` string-equal, `.bytes` byte-equal, `.shaderCode` string-equal. This is what proves the `gridDepth===1` fast path emits verbatim current code. Cache-bust every import (`?t=Date.now()`) — Vite's dev module cache is sticky for compiler files; without it the worker may run pre-edit modules and you'll smoke-test stale code.

2. **The stride invariant (the single most load-bearing fact).** The flat resolved neighbour table stride stays `coords.length` (=`coords3d.length` for 3D). DO NOT change the `nIdx_<nbr>[idx*nSz+k]` consumer arithmetic — only the LOOP that fills the table gains a `layer` dimension + a 3-tuple read. This is what makes the entire neighbour-access node family 3D for free.

3. **WebGPU `alphaMode` (PR7).** The present shader already unpacks alpha (`webgpuRuntime.ts:493-497`) but the canvas is `alphaMode:'opaque'` (`:516`) — it silently discards alpha until you flip it. A cross-target visual divergence (JS/WASM translucent, WebGPU opaque) violates lockstep — flip it in the same PR.

4. **`maxStorageBufferBindingSize` for big 3D grids (PR6/PR8).** `adapter.requestDevice()` defaults to a conservative 128 MB `maxStorageBufferBindingSize` even when the adapter supports 2 GB. A 3D volume multiplies cell count by `D` — a multi-attribute model at, say, 200³ = 8M cells blows the default for the attrs/colors buffers. The existing `requiredLimits` request + the defensive per-region check in `setupBuffersAndPipelines` should cover it; confirm the buffers are sized off the new `total = W*H*D`. The neighbour-offset buffer is NOT a concern (it stores only per-neighbourhood relative offsets, a few KB).

5. **Performance of 3D grids.** `total` scales by `D` — a 100×100×100 grid is 1M cells, 256³ is 16.7M. The engine is `total`-keyed and handles it, but (a) the WebGL2 renderer MUST cull to alpha>0 cells (never instance the full volume — §PR8); (b) huge dense 3D grids will stress the colors-buffer transfer (`total*4` bytes per step on the main thread in JS/WASM). The clip-plane reveal (PR8 commit 3) is both a UX feature and a perf relief (fewer visible instances when sliced). Keep default 3D grid sizes modest (8³–64³) in sample models.

6. **The legacy-default migration (PR1).** Every existing `.gcaproj` lacks `dimension`/`gridDepth`/`topologyMode`. The `LOAD_MODEL` guards default them to `'2d'`/`1`/`{gridCells:true,agents:false}` so all legacy files load as the top-left mode-matrix cell, byte-identically. `stringifyCompact` omits undefined fields — but if `defaultModel` seeds `gridDepth:1`/`dimension:'2d'` they WILL appear in every new save (cosmetic, harmless). The real legacy guarantee is that files WITHOUT them load fine (PR1 test 2).

7. **Recording-resolution change (PR8 commit 6).** The 2D path captures grid-resolution `ImageData`; a volume has no grid-resolution analogue, so 3D recording/screenshot capture the **display canvas** (`gl.readPixels`) at display resolution. This is a deliberate semantics change — document it. The WebM/GIF encoders already accept arbitrary ImageData sizes.

8. **The variegated 2D-lock (out of scope, but a tripwire).** The facing emitters (`wasm/compile.ts:1699+/1846+/4650+/5588+`) and the `& 3`/`& 7` rotation arithmetic bake 2D-square geometry. They only fire for variegated models, which stay 2D this milestone. **Do not touch them.** When `dimension==='3d'`, force variegation off / elide the V-tab ([PLAN §7.2](PLAN_BG_DIMENSIONS_AND_MODES.md)).

9. **The `neighborIndex` 2-axis codec (PR4 gate).** `packNI`/`unpackNI` pack exactly two 16-bit offsets — no third axis. Gate `GetNeighborAttributeByIndex`/`SetNeighborAttributeByIndex`/the `neighborIndex` value type/the picker behind `requirements.lattice2d` so the palette hides them in 3D. `GetNeighborAttributeByTag` (flat coord index) is the 3D substitute. The 3-axis codec redesign is explicitly deferred.

---

## §4 — What this milestone unblocks

This is the first cell of the [PLAN §1.3 build DAG](PLAN_BG_DIMENSIONS_AND_MODES.md) (`A` + `A2` + `M0a` + `X`). It deliberately builds the **shared infrastructure** the later morphogenesis work reuses:

- **The WebGL2 3D renderer (PR8) is built once and reused** by the 3D-agent path ([PLAN §1.3](PLAN_BG_DIMENSIONS_AND_MODES.md): "the 3D renderer is built once for A2 and reused — do not build two"). Bond-graph agents are spheres + bond tubes in the same camera/clip/instancing framework.
- **The 3D neighbour-offset table + coordinate decode (PR2/3/5/6)** is the lattice substrate the agent↔grid stigmergy loop ([PLAN §4](PLAN_BG_DIMENSIONS_AND_MODES.md)) scatters into / gathers from — a 3D morphogen field is just a 3D grid CA the agents read.
- **Authorable RGBA alpha (PR7)** is dimension- and topology-agnostic ([PLAN §8.4 note](PLAN_BG_DIMENSIONS_AND_MODES.md)): the same `setCellLooks.a` port serves the 2D lattice, the 3D grid volume, AND (later) the 3D agent spheres with one emitter change per target. The clip-plane + alpha plumbing is exactly the "see into the tissue" affordance morphogenesis needs.
- **The M0a Topology checkbox + the `dimension` schema** is the enabling shell for the later `M0b` two-graph split (which gates behind the agent compiler `B`, [PLAN §1.5 C1](PLAN_BG_DIMENSIONS_AND_MODES.md)) — the Agents checkbox is already in the UI, just disabled.

Nothing in this milestone forecloses the agent path; it lays the rails for it.

---

## §5 — Definition-of-done checklist

- [ ] **PR1** — `dimension`/`gridDepth`/`topologyMode` in schema + defaults + migration; Dimension radio + Topology checkboxes (Agents disabled) in Properties; `UPDATE_TOPOLOGY_MODE` reducer with ≥1 invariant; `updateTopologyMode` in both dep-array sites; HTML mockup shipped; HelpView/README updated. Legacy files load as 2D-grid byte-identically.
- [ ] **PR2** — worker `total = W*H*D`, 3-tuple offset table, `depth` threaded through init + args; `Life3D.gcaproj` sample; 3D offset table verified by independent re-bin (0 mismatches); 2D models unchanged.
- [ ] **PR3** — JS compiler emits `_layer` decode (3D) / verbatim 2-line (2D); 2D `stepCode` byte-identical; 3D-Life runs through the compiled step.
- [ ] **PR4** — `coords3d?`/`shape?` schema; `generateCoords3d` + parametric panel (primary); 2D-slice-stack editor + per-slice tags; `neighborIndex` family + picker gated off in 3D; HTML mockup; docs.
- [ ] **PR5** — WASM `total *= depth`, `gridDepth` on `MemoryLayout`, depth-gated 3-decode in `emitBody`; JS↔WASM exact parity on 3D-Life; 2D `bytes` byte-identical; facing emitters + `pushNiCellIdx` untouched.
- [ ] **PR6** — WebGPU `total *= depth`, `gridDepth` field, 3-stride nbrOffsets, 3D `nbrCellIdx` gated on `gridDepth`, row/col via `WH`; 3D-Life matches JS/WASM trajectory; 2D `shaderCode` string-identical (pipeline cache stable); `alphaMode` confirmed for PR7.
- [ ] **PR7** — `setCellLooks.a` port (3 targets, default 255); Color Scale + Categorical Color `a` output (full multi-output registration); WebGPU `alphaMode:'premultiplied'`; alpha=255 byte-identical on all 3 targets; sub-255 renders translucent on 2D + WebGPU.
- [ ] **PR8** — `gl3d.ts` WebGL2 instanced-cube renderer with culling; GL canvas sibling + `is3D` `draw()` seam (refs, not deps); orbit camera; clip/slice plane PRIMARY see-inside; opt-in per-cell alpha; GPU colour-id picking → flat `idx` into the existing paint/inspect protocol; display-canvas recording + screenshot; DEV `window.__sim3d*` hooks; no 2D regression; HTML mockup of the 3D viewport.
- [ ] **PR9** — `dimension`/`gridDepth`/`depth` round-trip in `.gcaproj`/`.gcastate`; depth dim-validation; spatial-indicator `'layers'` axis (worker + chart + dropdown gated on 3D); inspector neighborIndex left 2-axis with a TODO marker; docs.
- [ ] **Global** — `npx tsc -b` clean at every commit; every 2D library model byte-identical across all 3 targets before/after; the documentation lockstep (CLAUDE.md + HelpView + README + NODES_REFERENCE for the new `setCellLooks.a` port + the `lattice2d` requirement + the `'layers'` axis) updated atomically with the code; on a feature branch off `master`; no push, no Co-Authored-By.

---

### TL;DR

Nine ordered PRs: schema+UI shell (PR1) → JS 3D engine end-to-end, headless-verifiable via `getState` (PR2–3) → 3D neighbourhood parametric/slice editor + gate the 2-axis NI family (PR4) → WASM + WebGPU lockstep (PR5–6) → authorable RGBA alpha + WebGPU alphaMode (PR7) → the WebGL2 voxel renderer with clip-plane-first see-inside + colour-id picking (PR8) → save/load + spatial-`'layers'` + inspector consumer-scan (PR9). The engine is cheap (`total=W*H*D`, a 3-tuple offset table, a `_layer` decode, the stride untouched so neighbour access is 3D-for-free); the renderer is wholesale new. Guard every compiler PR with the cross-target byte-identity harness on the `gridDepth===1` fast path. Variegated stays 2D, agents stay disabled, the NI codec stays 2-axis — all out of scope. The renderer + 3D nbrs + RGBA alpha you build here are exactly what the later agent/morphogenesis milestones reuse.

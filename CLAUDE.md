# GenesisCA — Project Context for Claude Code

## Repository Context

This repository (https://github.com/rff255/GenesisCA) originally contained a Qt/C++ desktop application built in 2017 as an undergrad final project (Universidade Federal de Pernambuco). The `legacy_qt_cpp_solution` branch preserves that legacy code — a qmake project with `src/modeler` and `src/simulator` subdirectories, DearImGui-based node editor, and C++ code generation for model export.

**The current work is a complete rewrite.** `master` is the main branch and ships releases. Active development happens on feature branches off `master`. The `legacy_qt_cpp_solution` branch is frozen as historical reference — do not modify.

The old implementation in `legacy_qt_cpp_solution` serves as architectural reference. Key file for understanding the old compilation approach: `src/modeler/UpdateRulesHandler/node_graph_instance.h` — each node had an `Eval()` method that emitted C++ code snippets, stitched together into `.h`/`.cpp` files, then compiled to `.dll`/`.exe`. The new version follows the same pattern but targets JavaScript instead of C++.

---

## Commands

- `npm run dev` — Start Vite dev server (http://localhost:5173)
- `npm run build` — TypeScript check + production build to `dist/`
- `npm run preview` — Preview production build locally

---

## What GenesisCA Is

GenesisCA is an IDE for modeling and simulating Cellular Automata (CA). It uses a Visual Programming Language (VPL) — a node-based graph editor — so users can design arbitrarily complex CA models without writing code. The goals are **accessibility** (no programming required) and **performance** (grids up to 5000×5000+).

---

## The GenesisCA Model Definition

### Six Fundamentals

Every GenesisCA model satisfies these theoretical properties:

1. Cells have unlimited computing power
2. Cells have N internal attributes (of multiple data types), whose snapshot of values at a given generation is called its "state"
3. Cells are limited to only access (read) the states of cells in one of the neighborhoods defined in the CA model
4. **Writability** — In synchronous (classic) mode, cells can only modify their own attributes. In asynchronous mode, cells can also directly modify the attributes of neighboring cells, enabling movement and mass-conservation rules.
5. Space and Time are discrete (cells arranged in n-dimensional grid)
6. **Synchronicity** — The model can be either synchronous (all cells update simultaneously each generation — classic CA) or asynchronous (cells update sequentially using a single buffer, enabling number-conserving models where elements move across the grid without being created or destroyed). Async supports three update schemes: Random Order (Fisher-Yates), Random Independent (with replacement), Cyclic (fixed order from init).

### Simulation Essentials (Color Mappings)

Beyond the six fundamentals, two types of mappings enable visualization and interaction:

1. **Attribute-Color Mappings** — N ways to map cell state → colors (for visualization)
2. **Color-Attribute Mappings** — N ways to map colors → cell state (for user interaction and image-based initialization)

### Model Structure

A complete GenesisCA model definition consists of:

1. **Model Properties**
   - 1.1. Presentation (Name, Rule Author, GenesisCA Project Author, Description...)
   - 1.2. Structure (Topology, Boundary Treatment, Grid Size...)
   - 1.3. Execution
     - 1.3.1. Initial Configuration (Attribute Initialization Mapping, Default Attribute Values)
     - 1.3.2. End Conditions (optional max generations + indicator rules with category support for linked-frequency) + in-graph Stop Event nodes

2. **Attributes** — each has a name, type (bool, integer, float, tag, color), description, and type-specific properties (integer range, tag options...)
   - 2.1. Cell Attributes (per-cell state)
   - 2.2. Model Attributes (global read-only parameters that all cells can access but not write; can be changed during simulation externally)

3. **Neighborhoods** — a list of neighborhoods, each being a list of N indexes relative to the central cell, a name, a description, and optionally tags for specific indexes (for easy reference in Update Rules)

4. **Color Mappings** — each mapping has a Name, Description, per-channel descriptions (R, G, B)
   - 4.1. Color-Attribute Mappings (input: for initialization and real-time interaction)
   - 4.2. Attribute-Color Mappings (output: for visualization modes)

5. **Update Rules** — a node graph defining what each cell computes per generation. The graph handles multiple event types:
   - Each Attribute Initialization Mapping event
   - New generation (the main update step)
   - Each Color-to-Attribute interaction event
   - When/how to update each Attribute-to-Color mapping

---

## Architecture Decisions (Settled)

### Tech Stack

- **TypeScript + React** — the entire application
- **Vite** — build tool (replaces qmake)
- **React Flow** — node-based graph editor library (replaces DearImGui node editor)
- **Canvas2D** — grid rendering (initial target)
- **WebGPU** — future upgrade path for 5000×5000+ grids
- **Web Workers** — simulation engine runs off the main thread
- **GitHub Pages** — free static hosting, no server required

The app is **100% client-side**. No backend, no server, no paid hosting.

### Two Application Modes

- **Modeler** — UI for designing CA models (properties, attributes, neighborhoods, mappings, update rules graph). All editing panels are React components.
- **Simulator** — Runs and visualizes models. Grid rendering via Canvas, simulation loop in a Web Worker.

Both modes coexist in one app. The user can seamlessly switch between editing and simulating.

### Graph → Compile Strategy

This is the critical performance decision. At 5000×5000 (25M cells), the update function runs 25M times per generation.

**Approach: Compile the node graph at edit time to one of three targets.** Selectable per-model via the Compile Target radio in Properties → Execution.

- **WebAssembly (default).** Hand-emitted WASM module, typically several times faster than JS on dense neighborhoods. Production target for most models.
- **WebGPU.** WGSL compute shaders dispatched on the GPU. Best for very large grids and math-heavy per-cell work. Requires synchronous mode + a browser with WebGPU support.
- **Debug / Reference (JS).** Plain JavaScript via `new Function(...)`. Slower than WASM, but its source is readable in the simulator's Show Code panel — useful for prototyping new node types and verifying parity with the other targets.

Each node type defines `compile()` (JS) plus per-target emitters (WASM / WGSL). The JS compiler:
1. Topologically sorts the graph
2. Resolves connections (output of node A → input of node B)
3. Stitches snippets into a flat function body with intermediate variables
4. Creates an executable function via `new Function(...)`

Example — the JS compile of a Game of Life graph emits a loop-wrapped step function (called ONCE per step, not per cell):
```js
(function(total, r_alive, w_alive, nIdx_moore, nSz_moore, modelAttrs, colors, activeViewer) {
  const _scr_n1 = new Array(nSz_moore); // scratch array (reused per cell)
  for (let idx = 0; idx < total; idx++) {
    const colorIdx = idx * 4;
    w_alive[idx] = r_alive[idx]; // copy prev state
    const _nb = idx * nSz_moore;
    for (let _n = 0; _n < nSz_moore; _n++) _scr_n1[_n] = r_alive[nIdx_moore[_nb + _n]];
    let _count = 0;
    for (let _n = 0; _n < _scr_n1.length; _n++) if (_scr_n1[_n] === 1) _count++;
    const _alive = (_count === 3 || (r_alive[idx] && _count === 2)) ? 1 : 0;
    w_alive[idx] = _alive;
    if (activeViewer === "default-viz") {
      colors[colorIdx] = _alive ? 76 : 13; colors[colorIdx+1] = _alive ? 201 : 27;
      colors[colorIdx+2] = _alive ? 240 : 43; colors[colorIdx+3] = 255;
    }
  }
})
```

This mirrors how the old Genesis worked — each node's `Eval()` produced C++ code, stitched into `.h`/`.cpp`, compiled by gcc into `.dll`/`.exe`. The only difference: the target language is JS instead of C++, and compilation is instant (no external toolchain). Grid uses Structure of Arrays (typed arrays per attribute) for cache-friendly access.

**Why not interpret the graph at runtime:** At 25M cells, even ~2μs overhead per cell = ~50 seconds per generation. Compiled JS with JIT optimization targets ~10-50ns per cell = ~0.25-1.25s per generation.

A "debug/step mode" that interprets the graph slowly with visual feedback (highlighting active nodes, showing intermediate values) is planned for when users are designing — then switch to compiled mode for simulation runs.

### Model File Format

Models are saved as `.gcaproj` files with a versioned schema. The JSON contains:
- Schema version (for future migration)
- All model properties, attributes, neighborhoods, color mappings
- The full node graph (nodes, connections, positions) as serialized React Flow state
- The compiled JS function string (optional, can be recompiled from graph)
- Optional `simulationState` — embedded simulation snapshot (included when user saves state in the simulator before saving the project)

Users can save/load these files locally (browser download/upload). No cloud storage.

### Simulation State Files (.gcastate)

Standalone simulation snapshots saved from the simulator transport bar. JSON containing:
- Generation, grid dimensions, all cell attribute arrays (base64-encoded typed arrays)
- Model attribute values, indicator state (standalone + linked accumulators), color buffer
- Simulator UI settings (activeViewer, brush, FPS, gens/frame)

Serialization: `fileOperations.ts` — `serializeSimState()`, `readStateFile()`, `arrayBufferToBase64()` / `base64ToArrayBuffer()`, `deserializeTypedArray()`

Worker messages: `getState` (worker copies and transfers all typed arrays), `loadState` (worker restores arrays and rebuilds neighbor indices). Dimension validation in `applySimulationState()` rejects mismatched state files.

Auto-save to localStorage strips `simulationState` to avoid exceeding quota on large grids.

### Presentation Export

A "presentation" export bundles the Simulator + a compiled model into a **single self-contained `.html` file**. Anyone can open it in a browser — no install, no server. This replaces the old Genesis's standalone `.exe` export.

---

## Project Structure

```
genesis-ca/
├── CLAUDE.md
├── package.json
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── vite.config.ts
├── index.html
├── public/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   └── FileMenu.tsx              # New/Save/Load buttons
│   ├── modeler/
│   │   ├── ActivityBar.tsx           # Icon sidebar for panel switching (left)
│   │   ├── RightActivityBar.tsx     # Mirrored icon sidebar (Explorer + Palette tabs)
│   │   ├── PanelShell.tsx            # Panel wrapper (header + scrollable body)
│   │   ├── ModelerView.tsx
│   │   ├── panels/                   # Panel content components
│   │   │   ├── PropertiesPanelContent.tsx
│   │   │   ├── AttributesPanelContent.tsx
│   │   │   ├── NeighborhoodsPanelContent.tsx
│   │   │   ├── MappingsPanelContent.tsx
│   │   │   └── PalettePanelContent.tsx  # Palette tab: nodes + default + project macros
│   │   └── vpl/                      # Visual Programming Language editor
│   │       ├── CaNode.tsx            # Custom React Flow node component
│   │       ├── types.ts              # Port/node type definitions
│   │       ├── GraphEditor.tsx
│   │       ├── graphState.ts          # Shared mutable state (avoids circular imports between GraphEditor/CaNode)
│   │       ├── NodeExplorer.tsx        # Right-side searchable node list panel
│   │       ├── nodes/                # ~70 node types (one file each) + registry.ts
│   │       │   ├── nodeValidation.ts  # detectMissingConfig() — drives warning badges
│   │       │   └── colorScalePresets.ts # Named palettes (Viridis/Magma/Rainbow/…) for Color Scale + Linked mappings
│   │       ├── widgets/              # Shared inline editors (InlineWidgets.tsx, GradientStopsEditor.tsx)
│   │       └── compiler/
│   │           ├── compile.ts        # Two-pass compiler (hoisted values + flow)
│   │           └── linkedOutputMappings.ts # Synthesizes the auto color pass for Linked Output Mappings
│   ├── simulator/
│   │   ├── SimulatorView.tsx         # Canvas rendering, zoom/pan, brush tool
│   │   ├── IndicatorDisplay.tsx      # Indicator values display in simulator
│   │   └── engine/
│   │       ├── SimEngine.ts          # Fallback engine (reference only)
│   │       └── sim.worker.ts         # Web Worker — owns grid, runs steps
│   ├── help/
│   │   └── HelpView.tsx              # In-app comprehensive Help tab
│   ├── library/
│   │   └── ModelsLibrary.tsx         # Models Library tab (fetches from public/models/)
│   ├── model/
│   │   ├── ModelContext.tsx           # React Context + useReducer
│   │   ├── macroImport.ts            # cloneMacroWithFreshIds — ID regen for macro imports; countMacroInstances — linked-copy count
│   │   ├── defaultModel.ts           # EMPTY_MODEL (for New + the initial state on every app load)
│   │   ├── fileOperations.ts         # .gcaproj save/load/download + .gcastate serialization
│   │   ├── schema.ts
│   │   └── types.ts                  # TypeScript types for CAModel
│   └── export/                       # Presentation .html builder (planned)
├── public/
│   ├── models/                       # Library .gcaproj files (index.json auto-generated by Vite plugin)
│   └── macros/                       # Default .gcamacro files (index.json auto-generated by Vite plugin)
├── docs/
│   └── NODES_REFERENCE.md            # Node catalogue + Mermaid diagrams + redundancy analysis
├── .github/
│   └── workflows/deploy.yml          # GitHub Pages deployment via GitHub Actions
```

---

## Development Guidelines

- Language: TypeScript (strict mode)
- All new code and documentation in English
- The original undergrad thesis (in Portuguese) exists as reference material but is not part of the codebase
- Prefer modular, readable code. Each node type is its own file. The compiler is separate from the editor.
- Do not assume file structure beyond what's documented here — ask if uncertain
- When building new node types, follow the established pattern of existing nodes (compile method, port definitions, UI component)
- `NodeTypeDef` includes optional `description` (one-line summary of what the node does). Include it in new node definitions for Add Node menu tooltips.
- **Documentation consistency (keep ALL sources of truth in sync — do this after every feature change, not as an afterthought):** A change isn't done until every layer that describes it is updated, because future context-gathering relies on them agreeing. Update: (1) the **code itself** — structure + the comments/docstrings near what you changed; (2) **this `CLAUDE.md`** — extend/add the relevant feature section AND the Project Structure tree when files are added/moved; (3) `src/help/HelpView.tsx` (in-app Help tab); (4) the root `README.md`; (5) for node-system changes (new nodes, port types, redundancies) also `docs/NODES_REFERENCE.md` (table + node count + Mermaid diagrams). Drift between any of these silently degrades every later change, so treat them as one atomic update.
- **Pre-commit type check:** Vite dev server does NOT type-check — always run `npx tsc -b` before committing to catch TypeScript errors that will fail the CI build. Note: `npx tsc --noEmit` (without `-b`) silently checks nothing because the root tsconfig has `"files": []` and only project references.
- **Debugging blank-screen React crashes:** When the app whites out (React unmounts on uncaught error), console usually only shows generic "error in `<X>` component" warnings without stack traces. Install a `window.onerror` handler via preview_eval BEFORE reproducing, then read captured errors after — this surfaces the real stack trace.
- **Dismissing a user bug report requires concrete contradicting evidence**, not a plausible-sounding alternative narrative. Byte-level "the data round-trips correctly" is necessary but not sufficient — when the user is certain something is wrong, step the simulation end-to-end and inspect observable behavior (e.g., post-load `getState` + per-step NI histograms). Plausible-sounding stories ("the saved data already has bias, the simulation just preserves it") cost iterations when the actual bug is one indirection away from where you're looking.
- **Version display:** When bumping version, update ALL FOUR places: `package.json`, `package-lock.json` (root + first `packages.""` entry), the hardcoded version string in `src/App.tsx` header (`v1.X.0`), and the badge in `README.md` (`<sup>v1.X.0</sup>`). Easy to miss; sweep with `grep -rn "v1\.[0-9]"` after bumping.
- **PR descriptions:** Never include "Built with Claude Code" or similar Claude/Anthropic attribution lines. User handles all attribution decisions.

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
- No external compilation toolchains. The graph compiles to WASM (default), WebGPU, or JS inside the browser instantly — all three compilers are hand-rolled in TypeScript.
- Do not modify the `legacy_qt_cpp_solution` branch. It is frozen as historical reference.
- All new work goes on feature branches off `master` (e.g., `ux_improvements`).

---

## Current Implementation Status

The app is functional with these major systems:

### State Management
- `src/model/ModelContext.tsx` — React Context + useReducer holding entire CAModel
- `src/model/defaultModel.ts` — `EMPTY_MODEL` seeds the app on every load
- `src/model/fileOperations.ts` — Save (.gcaproj) / Load / Download utilities
- No model auto-save / auto-restore across reloads — stripping partial state (`simulationState` / `presets` were too big for the ~5 MB localStorage quota) led to misleading restore-then-silently-lose-preset/grid flows. Explicit `.gcaproj` save only.
- `beforeunload` warning (ModelContext) fires when `state.isDirty` is true so accidental close/reload prompts the user. `isDirty` is reset by `NEW_MODEL`, `LOAD_MODEL`, and `MARK_SAVED` (FileMenu's Save handler calls `markSaved()` after a successful download).
- Default tab is always `library` (every tab/reload) — no first-launch flag. A one-shot cleanup in `ModelProvider` removes stale `genesisca_autosave` and `genesisca_has_launched` keys left over from older builds.

### Visual Programming Language (VPL)
- `src/modeler/vpl/GraphEditor.tsx` — React Flow-based node graph editor
- `src/modeler/vpl/CaNode.tsx` — Custom node component with per-type config UI
- `src/modeler/vpl/nodes/` — ~70 node types (67 selectable from the Add Node menu + 3 hidden macro boundary nodes), each in its own file with `compile()` method. Canonical list: `ALL_NODES` in [registry.ts](src/modeler/vpl/nodes/registry.ts). Async-only nodes (6): SetNeighborhoodAttribute, SetNeighborAttributeByIndex, MarkCellUpdated, SetFacingOrientation, SetNeighborOrientationByIndex, MoveSelfToNeighbor. Includes `StopEventNode` (flow input only, text widget for stop message — compiles to `if (_stopFlag[0] === 0) _stopFlag[0] = <1-based idx>;` first-match-wins; WASM emitter mirrors this via `i32.store` at `layout.stopFlagOffset`).
- Four "event" entry-point nodes: GenerationStep (per-gen logic), InitEvent (runs once per cell on simulator Reset — see Variegated Cells section), InputMapping C→A (brush), OutputMapping A→C (color pass)
- `src/modeler/vpl/compiler/compile.ts` — Two-pass compiler: hoists values, then emits flow
- Multi-output nodes (InputColor, GetColorConstant, MacroNode, ColorScale, FilterNeighbors, JoinNeighbors, GetFacingLabels, BreakDownNeighborIndex, InitEvent, GroupOperator with position output) use `_v${nodeId}_${portId}` naming
- Switch node: flow control with dynamic case ports, compiler emits if/else-if chain
- Aggregate node: accepts multiple connections on one isArray input port, operations: Sum/Product/Max/Min/Average/Median
- ProportionMap, Interpolation, ColorScale, ValueSwitch: math/color/select utility nodes (ColorScale replaced the legacy `colorInterpolation` node)
- GetNeighborAttributeByTag: resolves neighborhood cell tags to indices at compile time
- Multi-root support: Step (per-generation), InitEvent (per-cell init on Reset), InputColor (brush interaction), and OutputMapping (color pass) compile separately
- OutputMapping functions: loop-wrapped, always sequential (no shuffle), no copy lines; run once after all generation steps complete; skipped in unlimited gens mode via `skipColorPass` flag
- Paint with OutputMapping: prefers `runColorPass()` over `runStep()` so painting doesn't advance the simulation
- Right side panel: tabbed via `src/modeler/RightActivityBar.tsx`, two tabs — Explorer (existing) and Palette (`src/modeler/panels/PalettePanelContent.tsx`). Drag-drop from Palette to canvas via custom MIME `application/genesisca-palette`; payloads: `{kind: 'node'}`, `{kind: 'macro-default', file}`, `{kind: 'macro-project', macroDefId}`. Floating chevron tab on the graph area's right edge reopens the last-active panel.
- `addNodeAtPosition(nodeType, position, configOverrides?, label?)` in GraphEditor is the shared node-creation helper used by BOTH context menu Add Node AND palette drop. New flows that create nodes should call it (gets the Step-singleton check + pushSnapshot for free). Pass `label` for macro instances so the user-facing name appears above the "Macro" header.

### Simulation Engine (SoA Architecture)
- `src/simulator/engine/sim.worker.ts` — Web Worker owns grid as Structure of Arrays
- Grid storage: one typed array per attribute (`Uint8Array` bool, `Int32Array` int/tag, `Float64Array` float), double-buffered (sync) or single-buffer (async)
- Tag attributes: `Int32Array`, value = index into `tagOptions` string array
- Model attribute bounds: optional `hasBounds`, `min`, `max` fields on `Attribute` type (integer/float model attrs only). When both min & max set, simulator shows range slider alongside spinbox. Values clamped at UI level, no worker enforcement.
- Color model attributes: stored as 3 entries (`attrId_r`, `attrId_g`, `attrId_b`) in cachedModelAttrs
- Neighbor access: pre-computed `Int32Array` index tables (built at init, handles torus/constant boundary once)
- Step function is LOOP-WRAPPED: `(total, r_<attrs>..., w_<attrs>..., nIdx_<nbrs>..., nSz_<nbrs>..., modelAttrs, colors, activeViewer[, order])` — contains the for-loop, called ONCE per step
- Async mode: `order` param is an Int32Array of shuffled/random cell indices; loop uses `idx = order[_i]` instead of `idx = _i`; r_ and w_ params point to same typed arrays (single buffer); copy lines are skipped; buffer swap is skipped after step
- Async schemes: `random-order` (Fisher-Yates shuffle per step), `random-independent` (N random picks with replacement), `cyclic` (one-time shuffle at init)
- InputColor functions remain per-cell: `(_r, _g, _b, idx, r_<attrs>..., ...)`
- GetRandom in Bool mode: has a `probability` input port (inline number widget, default 0.5). CaNode.tsx filters it out when `randomType !== 'bool'`. Compiles to `Math.random() < prob ? 1 : 0`.
- GetNeighborsAttribute uses `_scr_<nodeId>` scratch arrays declared before the loop — never allocate in hot path
- **varName() registration**: Any node whose `compile()` emits a non-default output variable (e.g., `_v${id}_result`, `_v${id}_vals`, `_scr_${id}`) MUST have a matching special case in `varName()` in compile.ts. Without this, downstream nodes reference the wrong (undeclared) variable. Also register scratch arrays in all three locations: main pass, macro inline, nested macro inline.
- NEVER use `fn(...args)` in per-cell loops — V8 megamorphic spread kills performance
- Play pipeline chains from worker message handler (not rAF): receive result → draw → send next step
- Color output: SetColorViewer writes directly to RGBA buffer, checks `activeViewer` param for multi-viewer support
- Bool constants use `1`/`0` (not `true`/`false`) for typed array compatibility
- Paint: after InputColor writes to writeAttrs, copy back to readAttrs before runStep()
- Worker mutation handlers (paint, importImage, randomize, reset, writeRegion, clearRegion): after mutating cell attributes, refresh the display via `if (hasColorPass) runColorPass(); else if (stepFn) runStep(); else writeDefaultColors(); sendColors();`. Without the fallback, users without an Output Mapping see no visual feedback.
- `src/simulator/SimulatorView.tsx` — Canvas rendering via ImageData + zoom/pan, LMB=brush/RMB=pan
- Simulator settings persisted to localStorage (`genesisca_sim_settings`)
- Bottom transport bar: playback + speed sliders; top viewer bar: mapping tabs; collapsible side panels
- Keyboard shortcuts: Space=step (also pauses), Enter=play/pause, Esc=reset
- Brush cursor rectangle drawn on canvas; Ctrl+LMB drag to resize brush
- Recording: per-frame ImageData capture in `recordedFrames.current`. GIF path via `gifenc` (256-colour palette, max 512 px downscale); WebM path via `webm-muxer` (VP9 profile 1 4:4:4 chroma when supported, profile 0 fallback, native grid resolution, all-intra keyframing). Format selector on transport bar; default = WebM with auto-fallback to GIF on browsers without WebCodecs. Encoder lives in `src/simulator/recording/webmEncoder.ts`. Worker tracks a `recording` flag (toggled via `setRecording` message) so direct render still ships colors when capturing.
- Screenshot exports at display canvas resolution (not grid resolution) with nearest-neighbor upscale
- Recompile optimization: structural changes reinit worker, graph-only changes send `recompile` message (preserves grid state)
- Save/Load State: transport bar buttons (left side) save `.gcastate` / load `.gcastate`. Worker `getState` copies all typed arrays via `.slice()` and transfers them. Worker `loadState` restores arrays and rebuilds neighbor indices. `applySimulationState()` validates grid dimensions match before loading. Auto-save strips `simulationState` from localStorage to avoid quota overflow. Saving state also stores it in model context so next `.gcaproj` save includes it. On `.gcaproj` load, `pendingSimStateRestore` ref triggers restore after first worker `stepped` message.
- Save Project options: `genesis-capture-sim-state` CustomEvent carries `detail.include = { grid?: boolean; controls?: boolean }` (defaults to both true). SimulatorView resolves immediately when neither is wanted, or skips the worker round-trip for controls-only. All `SimulationState` fields are optional; `applySimulationState` restores grid and controls independently. When making new shared-serialized fields optional, also audit `readStateFile` validation and every consumer that reads them unconditionally.
- Save/load `ATTR_TYPE_MAP` ([fileOperations.ts](src/model/fileOperations.ts)) MUST list every cell-attr runtime type `createTypedArray` (sim.worker.ts) returns. A missing entry silently falls through to `'float64'`, mislabeling int32 buffers. Round-trips fine for some grid sizes, but constant-boundary's +1 sentinel makes attrs N+1 elements long, so 4(N+1) bytes is non-multiple-of-8 for ~half of all grid sizes — `new Float64Array(buffer)` throws `RangeError: byte length must be a multiple of 8` and `applySimulationState` (no try/catch around `deserializeTypedArray`) aborts the entire load silently. Failure mode: "click load, nothing happens" and the grid stays at the default state. When adding a new cell-attr type, register it in BOTH places at the same time.
- Save/load typed-array views: cell-attrs / colors / `orderArray` / `stopFlag` / `rngState` are all initialised as typed-array VIEWS over `wasmMemory` at baked-in offsets (see initGrid). Any restore handler that reads from a load message MUST copy into the existing view (`for i { dst[i] = src[i] }`) — never reassign the JS reference (`orderArray = new Int32Array(...)`). The WASM step reads through the baked-in memory offset, not the JS reference, so reassigning orphans WASM from JS-side mutations. orderArray hit this in 4d82145 and stayed latent until d581232's NI load fix made loads succeed for affected models — symptom was sequential cell iteration in async mode after load, producing strong directional bias in any rule that writes per-cell during the step.

### Key Patterns
- Connected-handles pub/sub: graphState.ts exports `subscribeConnectedHandles` / `getConnectedHandlesForNode(id)` / `setConnectedHandlesFromEdges(edges)`. CaNode subscribes once via `useSyncExternalStore` instead of `useStore(edges)` per node. GraphEditor rebuilds the map in `useLayoutEffect([edges])`; rebuild is diff-aware (reuses Set identity for unchanged nodes) so only affected nodes re-render. Any future per-node derived data should follow this pattern.
- CaNode `memo` uses reference equality on `data` (plus id/selected/dragging/parentId). React Flow's `updateNodeData` swaps only the mutated node's data ref, so other nodes skip re-render. Don't add deep comparators unless profiler demands.
- Node config validation: `src/modeler/vpl/nodes/nodeValidation.ts` exports `detectMissingConfig(nodeType, config, model)` returning issue strings. CaNode renders an amber `!` badge in the header when issues exist. New node types with required configs (attributeId, neighborhoodId, mappingId, indicatorId, tagName, etc.) MUST add a case to that switch — otherwise the compiler silently emits `_undef` placeholders.
- Vite dev server picks up new `public/<subdir>/` directories ONLY at startup. Adding a new folder (e.g. `public/macros/`) and fetching `/<subdir>/index.json` will return the SPA index.html until you restart the dev server.
- `window.confirm/prompt/alert` block `preview_eval` (the JS thread freezes; the eval times out and the page becomes unresponsive — even subsequent reload eval times out). Stub them BEFORE clicking buttons that trigger dialogs: `window.confirm = () => true; window.prompt = () => 'value'; window.alert = () => {};`. The "New" button in the navbar uses `window.confirm` for unsaved-changes prompts. Same trap applies to dispatching a synthetic `beforeunload` event — if the app's handler sets `e.returnValue = ''`, Chromium shows the real leave-site dialog and eval hangs. Assert the listener is wired via a different signal (e.g. track `addEventListener` calls) instead of dispatching the event.
- `preview_fill` (and plain `input.value = ...` assignment in eval) does NOT trigger React's `onChange` — React tracks the last-known value and skips the event if the setter wasn't the native one. Use the native setter + manual event: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'text'); input.dispatchEvent(new Event('input', { bubbles: true }));` (or `'change'` for `<select>`). Otherwise the controlled component's state stays stale and submit buttons gated on non-empty fields remain disabled. For `<input type="file">`, neither of those paths works — build a `DataTransfer`, populate `.items.add(file)`, assign `input.files = dt.files`, then `dispatchEvent(new Event('change', { bubbles: true }))`.
- `preview_console_logs` returns a persistent buffer — it accumulates across page reloads and is NOT cleared by `console.clear()`. To verify whether a specific error is still firing after a fix, hook `console.error` fresh in an eval (push to `window.__newErrors` and reset), run the reproduction, then inspect `__newErrors`. Don't trust "errors found in logs" as current evidence.
- Never call another component's state dispatch (prop callback, dispatched action) inside a `setState(updater => {...})` function — React treats the updater as render work, so external dispatches fire mid-render and throw "Cannot update a component while rendering a different component". Clear your own state first (`setState(null)`), then compute and dispatch externally; track any value you need in a local ref so pointerup/async handlers don't race with async React state.
- Destructuring swap `[arr[i], arr[j]] = [arr[j], arr[i]]` fails strict-mode type checks because TS can't prove array access is defined, so each side resolves to `T | undefined`. Use a temp variable: `const tmp = arr[i]!; arr[i] = arr[j]!; arr[j] = tmp;`. Applies anywhere we swap array elements in-place.
- React Flow's `onPaneContextMenu` doesn't respond to plain `dispatchEvent('contextmenu')` because of internal pointer-event filtering. Tests that need to verify pane right-click menus should set state directly or rely on the source-level diff. Node right-click DOES work via dispatchEvent on the .react-flow__node element. Ctrl+click for multi-select and pointer-drag box-select ALSO don't fire via synthetic events — for tests that need multi-selection, mutate the nodes array directly (adding `selected: true`) or accept source-level review. React's `onMouseEnter`/`onMouseLeave` are synthesized from `mouseover` with `relatedTarget` tracking, so a naive `dispatchEvent(new MouseEvent('mouseenter'))` doesn't fire them either. Escape hatch for any of these: grab the attached props via the internal key — `const props = el[Object.keys(el).find(k => k.startsWith('__reactProps$'))]` — then call `props.onMouseEnter?.({ currentTarget: el })` directly.
- `fileOperations.ts` uses a custom `stringifyCompact` for .gcaproj output (coords, edges, and nodes are inlined per item). It MUST filter `undefined` object properties and map `undefined` array entries to `null` — matching native `JSON.stringify` — otherwise files emit `"key": undefined`, which is invalid JSON and breaks load. `readModelFile` has a recovery path that strips `"<key>": undefined` patterns for files saved by older buggy builds + strips a UTF-8 BOM + surfaces parse errors with `position N` and a 40-char snippet.
- Canvas chart components (`IndicatorSparkline` / `IndicatorMultiLineChart` / `IndicatorStackedAreaChart`) ALWAYS mount the outer `<div ref={wrapRef}>`; only the inner `<canvas>` is gated on data availability. Early-returning `null` when `data.length < 2` leaves `wrapRef.current` null when the mount-time width-measurement effect runs, `width` stays at 0 forever, and the chart never appears even after data grows (remounting via collapse/expand is what "fixes" it). A `useLayoutEffect` fallback re-measures width on renders where `ResizeObserver` was lazy (common when parent transitions from `display:none`).
- **NodeTypeDef.`requirements`** (`{ async?: boolean, variegated?: boolean }` in [types.ts](src/modeler/vpl/types.ts)) is the unified per-node capability gate — it REPLACED the old hardcoded `ASYNC_ONLY_TYPES` set. `detectCapabilityRequirements` + `isNodeAvailable` in [nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts) drive: palette filtering, Add-Node menu, connection-drop menu (all hide nodes the current model can't satisfy), and the CaNode amber badge on already-placed violators. The compiler reads `def.requirements.async` directly. Async-only nodes (6): `setNeighborhoodAttribute`, `setNeighborAttributeByIndex`, `markCellUpdated`, `setFacingOrientation`, `setNeighborOrientationByIndex`, `moveSelfToNeighbor` — compiler emits an error if used in sync mode. (The neighbor-write ones would have copy lines overwrite neighbor writes; `markCellUpdated` has no scheduling meaning under parallel sync updates.) `getNeighborAttributeByIndex` is read-only and works in both modes. Both `setNeighborAttributeByIndex` and `getNeighborAttributeByIndex` accept an array index input (loops over all elements / takes element 0 respectively) — never coerce array→scalar via `(arr | 0)` because it silently returns 0 for any multi-element or empty array.
- Mark Cell Updated flag (`markCellUpdated` node, async-only): writes `1` into a per-cell Uint8 region at `layout.skippedOffset` (allocated `total` bytes, view in worker as `skippedArray`). The async cell loop emit injects `if (_skipped[idx] !== 0) continue;` at the top of every iteration (JS) and `i32.load8_u offset=skippedOffset` + `br 1` from inside `ifThen` (WASM — increment outerCounter BEFORE the `br` so the loop doesn't spin on the skipped cell). Worker clears the array via `.fill(0)` at the top of every step (transient, not persisted to save state). Also added `_skipped` to `buildLoopParams` after `order` so the JS step signature matches. WebGPU rejects the node automatically via `requirements.async` since async mode itself is rejected on the WebGPU target.
- JoinNeighbors is multi-output (`result` NI array + `count` scalar), same shape as FilterNeighbors. Both ops (union + intersection) now use the multi-output `_v<id>_result` / `_v<id>_count` variable convention in JS; the union path used to emit `const _v<id>` (single-output) and is now consistent. Scratch is allocated unconditionally for both ops (was intersection-only). `isMultiOutput()` in `compile.ts` includes `joinNeighbors`. WASM array emitter caches the count port via `setCachedPort(ctx, id, 'count', { localIdx: outLenLocal, valtype: I32 })`; WebGPU emitter caches via `setCachedPort(ctx, id, 'count', { expr: out.lenName, type: 'i32' })`. Both targets also expose a value-emitter entry that calls `compileArrayNode` then returns the cached count, mirroring filterNeighbors' dispatch.
- Neighbor-write nodes use `if (_ni < total)` guard to protect constant-boundary sentinel from corruption
- Graph state sync: single debounced sync (100ms) via refs — never use multiple setTimeout callbacks
- Graph editor mouse: RMB click=context menu, RMB drag=pan (`panOnDrag={[2]}`), LMB click=select, LMB drag=box select (`selectionOnDrag`); simulator: LMB=brush, RMB=pan
- Shared mutable state: `graphState.ts` holds module-level variables (`isConnectingGlobal`, `showPortLabelsGlobal`, `connectingFrom`) to avoid circular imports between GraphEditor↔CaNode
- Module globals that drive memoized React components (e.g. `showPortLabelsGlobal` → CaNode): wire them through `useSyncExternalStore(subscribe, snapshot)` with a `Set<() => void>` listener list; setters must notify listeners. Without pub/sub, memoized consumers don't re-render on toggle and the global can drift out of sync with local React state across remounts.
- Connection validation: `isValidConnection` on ReactFlow prevents flow↔value, self-connections, occupied value inputs, and cycles (BFS from target)
- Connection highlighting: `connectingFrom` in graphState stores `{ category, kind, nodeId }`. CaNode checks BOTH category match AND opposite direction (`kind !== 'input'` for input ports, `kind !== 'output'` for output ports).
- Port labels render outside nodes (absolute positioned left/right of handles); controlled by `showPortLabelsGlobal` toggle
- Inline port widgets: stored in node config as `_port_${portId}` keys; compiler reads via `getInlineValue()` helper
- Node collapse: `isCollapsed` flag in node data; collapsed nodes render all handles at `top: 50%`; `isConnectingGlobal` triggers hover-to-uncollapse
- Group node RMB passthrough: CSS `:global(.react-flow__node-groupNode) { pointer-events: none !important; }` with `[data-drag-handle]` re-enabled
- Context menu: pane menu uses hover submenu (`.contextSubmenuTrigger` > `.contextSubmenu`); paste uses `pasteFlowPos` ref for right-click position
- ReactFlowProvider lifted to ModelerView (not inside GraphEditor) so NodeExplorer can access useReactFlow/useStore
- Simulator overlays: ALL overlay elements on the canvas (stats, transport bar, viewer bar, zoom controls, panel expand buttons) MUST have `data-sim-overlay` attribute. Mousedown handler sets `canvasBrushActive` flag; mousemove brush painting checks this flag to prevent accidental painting when interacting with overlays.
- Hide React Flow's persistent selection rect: CSS `:global(.react-flow__nodesselection-rect) { display: none !important; }`
- Groups use React Flow's native `parentId` — auto-resize requires manual bounding box computation in `handleNodesChange`
- Use `NodeResizer` for resizable nodes (comments, groups) — CSS `resize: both` conflicts with React Flow drag. NodeResizer updates `node.measured.width/height` and top-level `node.width/height` on resize end — NOT `node.style.width/height`. To persist across save/load: (1) `toRFNodes` seeds `rfNode.style = { width, height }` from `data` for the initial render, (2) the resizer's `onResizeEnd` callback writes back to `data` via `updateNodeData`, and (3) `toGraphNodes` reads `measured.width ?? node.width ?? style.width` (measured wins) when serializing. Without all three, mid-session resizes are lost on save.
- MacroNode, MacroInputNode, MacroOutputNode are hidden from Add Node menu via `HIDDEN_FROM_MENU` set
- Undo/redo: `graphHistory.ts` module-level undo/redo stacks (max 50 snapshots). Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo. Snapshot pushed BEFORE each mutation. History cleared on scope change.
- `isMultiOutput()` helper in compile.ts replaces raw `MULTI_OUTPUT_TYPES.has()` — also checks `getModelAttribute` with `isColorAttr` config
- CaNode config: NEVER call `updateConfig()` twice in sequence — second call uses stale `nodeData.config`, losing the first update. Instead, build the merged config object and call `updateNodeData(id, { ...nodeData, config: newConfig })` once.
- CSS gotcha: `flex: 1` on buttons inside flex-column containers causes them to stretch vertically. Remove `flex: 1` from buttons that should have fixed height.
- Nullish coalescing: never mix `??` with `||` or comparison operators without explicit parens — Babel/esbuild will warn or error.
- Simulator lifecycle: SimulatorView is always-mounted (wrapped in `display:none` div when not visible). Simulation auto-pauses when leaving the tab. Canvas redraws via `requestAnimationFrame` when `visible` transitions to true. The `useEffect([model, compileModel])` fires on every model change (even while hidden), handling full reinit or soft recompile as appropriate. When `model.indicators` changes during soft recompile, an `updateIndicators` message is sent to the worker alongside the `recompile` message.
- Simulator save integration: FileMenu dispatches `genesis-capture-sim-state` CustomEvent with `detail.resolve` callback. SimulatorView captures worker state via `getState` and calls `resolve()` after `setSimulationState()`. FileMenu `await`s the Promise before serializing. 5-second safety timeout.
- Copy/paste: Ctrl+C/V/X + context menu. Module-level `clipboard` variable, strips macroInput/macroOutput, remaps IDs
- Group paste: parentId must be remapped to new IDs, children keep relative positions, groups sorted before children
- React StrictMode double-mount: effects run mount→cleanup→mount in dev. When terminating resources (Web Workers), always null out the ref (`workerRef.current = null`) after `.terminate()` so the second mount detects it needs a fresh init instead of reusing a dead reference.
- Indicator values use a ref (`indicatorValuesRef`) not React state — avoids extra re-renders on every worker step message. The existing `setGeneration` re-render reads the ref naturally.
- Linked indicator aggregation is always post-loop (not in-loop) to avoid async mode single-buffer corruption where mid-loop reads see a mix of old and new cell values.
- Neighborhood tags: `Neighborhood.tags?: Record<number, string>` maps coord index to tag name. Tags are optional per-cell labels for neighbor positions.
- `inputToSources` (plural) map in compile.ts: collects ALL edges targeting the same value port. Used for multi-connection `isArray` ports on Aggregate node.
- Connection validation: `isValidConnection` allows multiple edges to the same target handle when the target port has `isArray: true`.
- Switch node dynamic ports: case output ports generated from `caseCount` + `case_N_value` config keys, similar to macro dynamic ports.
- Context menu: clamped to viewport bounds via `useLayoutEffect` + ref measurement after render. Initial render with `visibility: hidden`.
- Modeler PanelShell: resizable via drag handle on right edge (200-600px range). Pattern matches simulator right panel.
- Group shrink-to-fit: `resizeGroupsToFit(nds, allowShrink)` runs on graph load with `allowShrink=true`. Prevents stale bloated groups.
- Input drag fix: `stopDrag` callback checks `e.button === 0` (LMB only) to allow RMB pan through nodes. `stopAll` stops all buttons (for double-click). Body div uses `onDoubleClick={stopAll}` to prevent collapse; inline widgets use both `onMouseDown={stopDrag}` and `onDoubleClick={stopAll}`.
- Compiler: in `compileFlowChain`, EVERY `varName()` call MUST be preceded by `compileValueNode(source.nodeId)` to ensure the value variable is declared. This applies to ALL flow node handlers (conditional, loop, switch, regular). Missing this causes undefined variables at runtime.
- Model element cleanup: `ModelContext.tsx` reducer uses `patchAllNodes()` / `clearDeletedId()` helpers to update node configs when attributes/neighborhoods/mappings/indicators are deleted. Tag option deletion remaps indices in getConstant, switch, and setAttribute nodes. Always scan both `graphNodes` and `macroDefs[*].nodes`.
- Graph nodes are heterogeneous: comment nodes (`type: 'commentNode'`) have `data: { text }` and group nodes have `data: { label, width, height, nodeType: 'group', config: {} }`. Any code iterating `model.graphNodes` must guard against `n.data.config` being undefined (e.g., `patchNodes` in ModelContext).
- Switch node: two modes (`conditions` = user-wired bool inputs per case; `value` = comparison ops per case with int/float/tag types). `firstMatchOnly` toggle: true = if/else-if chain, false = independent if blocks with `_sw{id}` guard variable. Tag mode uses equality against tag index; int/float mode uses configurable comparison op (==,!=,>,<,>=,<=).
- PanelShell `side` prop: `'left'` (default) puts resize handle on right edge; `'right'` puts it on left edge with inverted drag math. NodeExplorer uses `side="right"`. Simulator left panel has its own resize handle (`.leftPanelResizeHandle`).
- Show Code: `buildFullCode()` in SimulatorView concatenates step + all inputColor + all outputMapping functions with section headers. Uses mapping names for readability.
- `inlineWidget: 'number'` ports on `setAttribute` / `updateAttribute` / `setNeighborhoodAttribute` / `setNeighborAttributeByIndex` can carry `'true'`/`'false'` strings in config: CaNode dynamically swaps the rendered widget to a bool `<select>` when the chosen attribute is bool, but the static port def stays `'number'`. `getInlineValue` must map `'true'→'1'` / `'false'→'0'` BEFORE `parseFloat` (matching `parseInlineNum`) — otherwise NaN falls back to `defaultValue '0'` and every model that writes a bool attr via the inline widget breaks on ALL THREE targets (JS/WASM/WebGPU all chain through `getInlineValue`).
- Inline `<input type="number">` widgets MUST set `step="any" lang="en" inputMode="decimal"`. Default `step="1"` makes decimals step-invalid; on some Chromium/locale combinations `.value` returns `""` for `0.2`-style entries → `getInlineValue` falls back to `defaultValue '0'` → "always-true" comparison bug (Compare's `>= 0.2` was the canonical reproducer).
- `onConnectEnd` signature in xyflow v12 is `(event, connectionState)`. `connectionState.toHandle == null` is the canonical "released not on a port" signal — works for releases on the pane AND on a node body. If onConnectEnd sets context-menu state (e.g., the connection-drop compatible-nodes menu), beware: the same LMB-up that fires onConnectEnd ALSO fires the editor wrapper's synthesized `click`, which closes the menu the moment it opens. Use a one-shot `suppressNextEditorClickRef` flag set in onConnectEnd and consumed by the wrapper's onClick.
- A new flow-control node with DYNAMIC flow outputs (Switch-style `case_N`, Sequence-style `then_N`) requires edits in ALL of: NodeTypeDef (+ defaultConfig counter), CaNode dynamic-port derivation + +/- UI, [effectivePorts.ts](src/modeler/vpl/effectivePorts.ts) (consumed by panel-drag + connection-drop helpers), `compile.ts` × 2 sites (compileInnerFlow + compileFlowChain), `wasm/compile.ts` × 2 sites (compileFlowChain + visitFlow), `webgpu/compile.ts` × 3 sites (preEmitValueNodes + compileFlowChain + analyzeAlwaysWritten), and `sinkAnalysis.ts` if the node belongs in `TRANSPARENT_FLOW_TYPES`.
- Worker `self.onmessage` is sync — `await` directly inside a `case` body is a syntax error. Wrap async work in `void (async () => { ... })()` IIFE (same pattern as `setUseWasm`), OR keep the await out of the message handler entirely.
- Module-level `let` exports from `graphState.ts` are LIVE bindings — reading the imported identifier inside a callback always sees the current value at call time (no ref needed). Used for `compatibleHandlesForDrag` and `currentModelElementDrag`. Safer than refs when the consumer is a pure function or non-React module.
- Panel-drag drop on a port (Attribute / Neighborhood / Mapping → canvas): `onPaletteDrop` in GraphEditor.tsx computes the snap target via `findNearestCompatibleHandle` (DOM query at the drop point), then calls `resolveDropCandidates(payload, snap)` to filter `RELATED_NODES` by port-compatibility. When `resolved.length === 1`, the menu is skipped and the node is auto-created via `addNodeAndConnect`. Position is computed by `computeSnapPosition` (heuristic: ~200px estimated new-node width, ~24px per port row, ~30px gap on the correct side), then `scheduleSnapRefinement` schedules a one-shot RAF that measures the actual port screen positions via `getPortScreenCentre` and applies a precise delta. Both single-option and multi-option (menu click) paths share the same snap+refine pair. `addNodeAtPosition` / `addNodeAndConnect` now return the new node id (`string | null`) instead of `boolean` so the RAF refinement can locate the just-added node — existing callers that only checked truthiness still work.
- Accessor CSE: all three compilers run [accessorCSE.ts](src/modeler/vpl/compiler/accessorCSE.ts)'s `canonicalizeAccessorEdges` before sink analysis to dedup pure value-producing nodes (GetCellAttribute, GetNeighborsAttribute, arithmetic over them, etc.) that share a structural purity key. Sync-mode only (async-mode global no-op — single buffer means a read can change after an intervening write). See the "Accessor CSE" major section for purity rules and per-target wiring.

### Modeler UX & node additions (v1.15)
- **Group node interaction model**: LMB-drag on the group's **header strip** moves the group (React Flow `dragHandle` restricted to `[data-drag-handle="true"]`); LMB-drag on the **body** box-selects inner caNodes (driven through RF's `userSelectionRect` / `userSelectionActive` store + `triggerNodeChanges` on diff); LMB-click on the body selects the group; RMB on the body pans the pane (extended the edge RMB-passthrough handler). Header label is a span; double-click swaps in a focused input (select-all) for rename, blur/Enter/Escape exits.
- **Group box-select modifiers**: snapshot pre-selected ids in `onDown`, keep a running `appliedIds` set; at threshold crossing only `resetSelectedElements` for plain (no-modifier) mode. Shift = pre ∪ box, Ctrl/Meta = pre \ box, plain = box. The capture-phase listener lives on `document` (NOT the wrapper) so it sits ABOVE React's root in capture order — otherwise RF's `Pane.onPointerDownCapture` treats Shift as its selectionKey and finalizes the group into the selection via `getSelectionChanges(…, mutateItem=true)` before our `stopPropagation` can fire. A `boxFromGroupRef`-gated filter in `handleNodesChange` strips the group from the selection as defense-in-depth. Inner-node drag uses `member.startPos + totalDelta` (delta from drag-start group position) — NOT `nodesRef.current.position + per_tick_dx`, which reads stale positions on fast pointer-move bursts (faster than React renders) and leaves inner nodes lagging.
- **Panel → port snap + single-add**: dropping a model element (attribute / neighborhood / mapping / indicator) onto a compatible port spawns the new node aligned with that port. `findNearestCompatibleHandle` (DOM query at drop point) → `resolveDropCandidates` filters `RELATED_NODES` by port-compatibility; when exactly one fits, the menu is skipped and the node auto-creates. `computeSnapPosition` does heuristic placement, then `scheduleSnapRefinement` measures actual port screen positions via a one-shot RAF and applies a precise delta. `addNodeAtPosition` / `addNodeAndConnect` now return the new node id (`string | null`, was `boolean`) so the RAF can locate the just-added node.
- **Set Cell Glyph** ([SetCellGlyphNode](src/modeler/vpl/nodes/SetCellGlyphNode.ts)): per-cell u32 glyph codepoint + packed RGB tint buffers, allocated only when the graph references the node. Simulator overlays glyphs after the colour blit using a pre-rasterised tile cache keyed by (codepoint, colour, size); zoom-gated (hidden below ~6 px/cell) so overlay cost is bounded by viewport, not grid size. Unlocks per-cell orientation indicators (GetOrientation → Switch → arrow glyphs). Lockstepped JS/WASM/WebGPU.
- **Inline widget primitives** ([InlineWidgets.tsx](src/modeler/vpl/widgets/InlineWidgets.tsx)): the three inline port primitives (number / bool / tag) are extracted into one component, backing all 8 panel number inputs + the inline port widget. The number widget uses `type=text` + `inputMode=decimal` with a draft/commit dual-state model — fixes the long-standing Chromium bug where typing `-` (or a partial decimal) into a controlled `type=number` input was wiped on every re-render.
- **isArray scalar→array compatibility**: `portsCompatible` / `shapesMate` now permit scalar source → array target connections (only array → scalar is rejected). Dragging from an `isArray` input port (Aggregate.values, GetRandom.options) now lists scalar-producing nodes in the compatible-nodes menu — matching what `isValidConnection` already accepted and what the compilers handle via `inputToSources` multi-scalar wiring.
- **Interactive minimap**: pannable + zoomable; a click jumps the viewport to the clicked spot (keeps current zoom, 200 ms ease). Was a static overview before.
- **RMB-through-edges**: a capture-phase `pointerdown` handler on the editor wrapper catches right-button pointerdowns inside `.react-flow__edge`, `stopPropagation`s, and re-dispatches `pointerdown` + `mousedown` on `.react-flow__pane` so d3-zoom's pan-on-drag starts as if the user had pressed empty canvas. LMB on edges (select / double-click delete) is untouched.
- **Models Library sort**: cards ordered alphabetically by display name (case-insensitive `localeCompare`), so positions don't shuffle on every recompile (was filesystem `readdir` order).
- **Theme cleanup**: the Default Generic theme + `ThemeSwitcher` component were removed; Blender is the only shipped theme. `tokens.css` binds the Blender block to `:root` + `[data-theme="blender"]` (future themes can still override via a `data-theme` selector); the boot script in index.html pins `data-theme="blender"` unconditionally.
- **Simulator mapping tooltips**: A→C viewer tabs and C→A brush tabs expose `mapping.description` as a native `title` attribute (matches the existing model-attribute / preset tooltips).
- **Cell inspector**: neighborIndex attribute values decode to `(dr X, dc Y)` offsets (INVALID_NI → `INVALID_NI (no neighbor)`) instead of the raw packed i32; variegated models gain an orientation row (`<int> (N/E/S/W)`) above the attribute rows.
- **`tagConstant` retired**: folded into `getConstant.tag` (identical picker, same i32 emit on all targets). [tagConstantMigration.ts](src/model/tagConstantMigration.ts) mirrors `colorScaleMigration`'s pair pattern and is wired into `LOAD_MODEL` + `macroImport` so saved `.gcaproj` files with the old node keep loading after its removal from the registry/emitters/validation.

---

## Indicators (Implemented)

### Architecture:
- Two kinds: **Standalone** (typed scalar, graph-writable) and **Linked** (auto-computed from cell attributes)
- Standalone indicators support all types: bool, integer, float, tag — stored as JS numbers in `_indicators` object
- Linked indicators aggregate cell attribute arrays: Frequency (count per value) or Total (sum)
- Both kinds have Accumulation Mode: per-generation (reset each step) or accumulated (running total, reset on simulator reset)
- **X-axis** (linked only): `generation` (default — classic time-history) or `rows`/`columns` (a live **spatial histogram** = chromatogram; see Spatial Indicators below). Standalone indicators are Generation-only (a graph-written scalar has no spatial extent).

### Standalone Indicator Nodes:
- `GetIndicatorNode` (value, `'data'`): reads `_indicators[indicatorId]`
- `SetIndicatorNode` (flow, `'output'`): writes `_indicators[indicatorId] = value`
- `UpdateIndicatorNode` (flow, `'output'`): modifies based on type — Bool: toggle/or/and; Int/Float: increment/decrement/max/min; Tag: next/previous
- All three have teal color `#00695c`

### Compiler Integration:
- `_indicators` parameter added after `activeViewer`, before optional `order` in `buildLoopParams`, `buildCellParams`, and output mapping params
- Step function loop-wrapped: `_indicators` is a shared object across all cell iterations within a single step — enables accumulation patterns

### Worker Integration:
- `cachedIndicators: Record<string, number>` — mutable during step function execution
- `standalonePerGenIds` — per-generation indicators reset to defaults before each step
- `computeLinkedIndicators()` — iterates typed arrays after each step (frequency, total, with float binning)
- `computeSpatialIndicators()` — the spatial (rows/columns) sibling: bins each cell by position and aggregates per bin using the SAME per-type branches; writes `Record<seriesKey, number[]>` into `linkedResults` (see Spatial Indicators)
- `linkedAccumulators` — running state for accumulated linked indicators
- Indicator values included in `stepped` message as `indicators: Record<string, number | Record<string, number> | Record<string, number[]>>` (the `number[]` arm carries spatial series)
- `initIndicators()` called on init, `resetIndicators()` on reset/randomize
- `updateIndicators` message rebuilds indicator state when definitions change

### Modeler UI:
- `IndicatorsPanelSection` component rendered inside `PropertiesPanelContent`
- Standalone: type selector, default value (type-specific), tag options editor
- Linked: attribute dropdown (cell attrs only), aggregation (type-dependent), **Value Bins** (float + frequency only — renamed from "Bin Count" to disambiguate from spatial bins), **Track Categories** (bool/tag frequency only — a checkbox checklist to chart a SUBSET of category values), **X Axis** (Generation/Rows/Columns), and when spatial: **Bin Mode** (Slices/Absolute) + Number of Slices / rows-per-bin
- Both: accumulation mode radio, watched toggle, delete button
- **Track Categories / `Indicator.trackedValues?: string[]`** (bool/tag frequency only; absent/empty = all): filter the per-category frequency map to a chosen subset so a dominant category doesn't flatten the rest on the shared chart Y-axis. Applied at ONE point — `sendColors` in [sim.worker.ts](src/simulator/engine/sim.worker.ts) (message assembly, post-aggregation) — so it uniformly covers JS-embedded / WASM-worker / WebGPU-reduced results AND generation + spatial axes; integer/float frequency (dynamic/range keys) and `total` (scalar) are untouched. UI = `TrackCategoriesEditor` in `IndicatorsPanelSection`; full/empty selection stores `undefined` (track all). SimulatorView threads `trackedValues` through BOTH the `init` and `updateIndicators` worker payloads (the worker `IndicatorDef` + internal `linkedDefs` both carry it).

### Simulator UI:
- `IndicatorDisplay` component in right panel below brush controls
- Scalar values (standalone, linked total): single numeric display + sparkline chart (always-mount-wrapper pattern — see Key Patterns)
- Frequency maps (linked frequency): three viz modes cycled via a header button — **Bars** (`IndicatorDisplay` inline bar chart, current gen only), **Lines** (`IndicatorMultiLineChart`, one coloured line per category over time), **Stack** (`IndicatorStackedAreaChart`, cumulative-sum bands). Preference persists per indicator via `indicatorVizModes: Record<id, 'bars'|'multiline'|'stacked'>` inside `genesisca_sim_settings` localStorage.
- History shape in `SimulatorView.indicatorHistoryRef` is polymorphic: `number[]` for scalars, `Record<category, number[]>` for frequency maps. Capped at 500 samples per series.
- `chartExpandedRef` is populated by `IndicatorDisplay`'s render-phase ref-compare notification. Do NOT reset it in `initWorker`'s useEffect — that runs AFTER the child's render and wipes the populated set, so the first stepped messages collect no history (symptom: scalar sparklines stay blank until manual collapse/expand).
- Eye icon per indicator toggles `watched` state
- Spatial indicators (`xAxis` rows/columns) render `IndicatorSpatialChart` (one curve per series over position bins) — bypasses the scalar/freq branches, hides the viz-mode cycle button. `IndicatorDisplay` takes `gridWidth`/`gridHeight` props (live dims) to label the X-axis with real row/column positions.

### Spatial Indicators (chromatogram X-axis — purely a measurement/visualization layer):
- A spatial indicator plots value **per position bin** along the grid's `rows` or `columns` axis instead of over `generation` — reproducing the chromatogram plots in the Kier chromatography/enantiomer papers (population vs column position, one curve per species). **No graph nodes, no compiler changes, no per-cell position read** — it's one extra CPU pass in the worker, opt-in per linked indicator.
- **Why linked-only:** spatial binning = "scan all cells, bin each by position" = a cell-aggregation, which is exactly what linked indicators already do. Standalone indicators (a single graph-written scalar) have no spatial extent and stay Generation-only.
- **Data shape:** the per-step value is `Record<seriesKey, number[]>` — each array indexed by **position bin** (length = bin count). Each value-bucket the linked path already produces becomes a **series** (a curve): bool → `true`/`false`; tag → one per option (the chromatogram's per-species curves); integer freq → one per distinct value; integer/float **total** → single `total` (per-bin sum); float freq → one per **value-bin** (2-D value×position histogram). color/neighborIndex unchanged.
- **Two distinct bin counts — don't conflate:** `binCount` = **value** bins (float frequency only); `spatialBinCount` (slices mode) / `spatialBinSize` (absolute mode) = **position** bins. Only float+frequency uses both (value-bins → series, position-bins → array index).
- **Schema** (`Indicator`, all optional, additive — no migration): `xAxis?: 'generation'|'rows'|'columns'`, `spatialBinMode?: 'slices'|'absolute'` (default slices), `spatialBinCount?` (slices; default 50, clamped [2, axisLen]), `spatialBinSize?` (absolute; rows/cols per bin, default 1 → B = ceil(axisLen/size)).
- **Worker** (`computeSpatialIndicators` in [sim.worker.ts](src/simulator/engine/sim.worker.ts)): mirrors `computeLinkedIndicatorsFromBuffer` (same per-type branches + sub-attr parent-match guard) but bins by `row = ⌊i/width⌋` / `col = i % width`. `linkedDefs` carry the xAxis + bin config; `hasSpatialIndicators` gates the per-step call. Writes `linkedResults[id]` as `Record<key, number[]>`.
- **Buffer/timing (the critical gotcha):** called **post-step, after the buffer swap/copy**, so `readAttrs` holds the just-computed generation on JS (ref-swap) AND WASM (w→r copy) — the same buffer a later `getState` reads, which is what makes the parity check exact. On WebGPU it runs inside `finalizeStepWebGPU` after the attrs readback; spatial source attrs (and their parents, for sub-attrs) are force-added to `watchedAttrIds` so the selective readback always pulls them even when a sibling generation-axis indicator on the same attr is GPU-reduced.
- **Never accumulated:** spatial is always a live per-step snapshot (the accumulation loop + history collection both skip it; SimulatorView detects array-valued entries structurally). End conditions exclude spatial indicators (a spatial value isn't a scalar/category count); the end-condition target dropdown filters them out.
- **WebGPU:** spatial indicators are CPU-only — `buildReductionPlan` ([webgpuReduce.ts](src/simulator/engine/webgpuReduce.ts)) skips any `xAxis` rows/columns def.
- **Verified** (tsc + cross-target parity): per-bin series match an independent `getState` re-bin with 0 mismatches and sum-of-bins == per-value total, on JS (columns) / WASM (rows) / WebGPU (rows), both slices and absolute modes.

### Manual Brush (runtime-only Input Mapping):
- Special "Manual" tab that always appears as the rightmost entry in the right-panel brush mapping strip, alongside the model's color-input mappings. Renders even when the model has zero color-input mappings (also auto-selected on load in that case). Does NOT appear in the Modeler's Mappings tab — it's purely a simulator UX layer with no model-schema counterpart.
- Selecting Manual swaps the color picker for a `<ManualBrushPanel>` (one row per cell attribute: `[Set checkbox] [name + sub-attr hint] [type-appropriate widget]`). Widgets reuse `InlineNumberInput` / `InlineBoolSelect` / `InlineTagSelect`. Unchecked rows are dimmed (`.manualBrushWidget.dim` — `opacity: 0.4; pointer-events: none`) and their attribute is skipped at paint time.
- Worker protocol: `paintManual` message — `{type: 'paintManual', cells: [{row, col}], sets: [{attrId, value}], activeViewer}`. UI pre-encodes string values into typed-array numerics via `encodeAttrValue()` in `src/model/attrValueEncoding.ts` (shared with worker's `defaultValue()`/`boundaryCellValue()`). Bypasses any compiled `InputColor` function. Worker handler mutates `readAttrs[attrId][idx]` directly (plus `writeAttrs[...][idx]` in sync mode for next-step consistency), works on JS, WASM, and WebGPU targets without per-target code paths — WebGPU branch readbacks attrs first when `gpuOwnsAttrs && needs parent-match read`, then patches per-cell via `patchWebGPUCells(idxs)`.
- Sub-attribute semantics: **per-cell skip**. For each sub-attr being Set, the worker computes the cell's *effective* parent value — the brush's parent value if the parent is itself in `sets` (`brushParentOverride` Map), else `readAttrs[parentId][idx]` — and suppresses the write when that value isn't in `parentValues`. Mirrors the schema's iteration semantics. `parentValueToInt` is now exported from `subAttribute.ts` for the worker to share.
- State: `manualBrush: Record<attrId, {enabled, value}>` in SimulatorView, persisted per-model in localStorage under `genesisca_manual_brush_v1:<model.properties.name>` (separate from the global `genesisca_sim_settings`; NOT saved into `.gcaproj` / `.gcastate` — Manual Brush is per-user UX). Signature-keyed merge effect (`cellAttrSig = "id1:type1|id2:type2|..."`) re-derives state when the attribute SET changes; live name/description edits don't reset values. New attrs seed `{enabled: true, value: defaultValue}`; deleted attrs vanish; type-changed attrs reset.
- Flush plumbing: `flushPaintBatch` ([SimulatorView.tsx](src/simulator/SimulatorView.tsx)) branches on the `MANUAL_BRUSH_MAPPING_ID` sentinel, snapshots `manualBrushRef.current` AT FLUSH TIME (so widget edits during a drag take effect mid-stroke), encodes values via `encodeAttrValue()`, posts `paintManual`. The existing mid-drag mapping-change flush path piggybacks on the sentinel — swapping in/out of Manual flushes correctly.
- Suppressed in Manual mode: Shift+RMB color popover (no color to set), Open Image button (image import requires a color mapping — disabled with explanatory tooltip), and the "Shift+RMB color" hint string. Ctrl+wheel cycle includes Manual as the rightmost entry.

### End Conditions & Stop Events:
- `ModelProperties.endConditions?: { enabled, maxGenerations?, indicatorConditions? }` — optional auto-pause rules evaluated on the main thread in `SimulatorView.evalEndConditions` after each `stepped` message; pauses play and shows a blue info notice.
- `IndicatorEndCondition.category?: string` — for linked-frequency indicators the comparison is `frequencyMap[category] <op> constant`. UI branches per linked attribute type: bool/tag → dropdown, integer → number input, float-binned → disabled with warning (bin keys aren't knowable at design time).
- Stop Event node compiles to a write into a shared `_stopFlag` Uint32Array (+ `layout.stopFlagOffset` for WASM). Worker reads the flag after every `runStep`, clears it at the top of each step, surfaces the message via a `stopEvent` message. Main thread pauses + shows the same blue notice. `stopMessages: string[]` passed via init/recompile; Stop Event config.`_stopIdx` is 1-based so 0 means "no stop requested".
- Saved state (.gcastate / embedded in .gcaproj) restores the grid configuration only. `generation` resets to 0 and indicators re-init on load — saved files represent starting configurations, not run snapshots. `serializeSimState` skips generation/indicators/linkedAccumulators on write; loader ignores them on read (back-compat with older files).

---

## Macro System (Implemented)

### Architecture:
- MacroInput/MacroOutput are boundary nodes inside macro subgraphs (teal, `#00897b`)
- MacroInput has OUTPUT ports (data flows into subgraph); MacroOutput has INPUT ports (data flows out)
- Ports are dynamic — derived from `MacroDef.exposedInputs`/`exposedOutputs` at render time
- Port editing UI on boundary nodes: add/remove/rename ports, value/flow category selector
- Changes propagate automatically — MacroNode's external handles re-derive from the same MacroDef arrays
- Boundary nodes cannot be deleted (filtered in `handleNodesChange` and `deleteSelection`)

### Create Macro from Selection:
- Auto-creates MacroInput (left of bbox) + MacroOutput (right of bbox) inside the subgraph
- `exposedInputs[i].internalNodeId` points to MacroInput node ID (not the actual internal target)
- Bridging edges connect MacroInput output ports → original internal targets
- Bridging edges connect original internal sources → MacroOutput input ports
- External edges are sorted by `internalNode.position.y * 1000 + portIdx` BEFORE building exposedInputs/exposedOutputs, so port order matches the visual top-to-bottom layout instead of arbitrary edges-array order. Port index resolves via `def.ports.filter(p => p.kind === kind).findIndex(p => p.id === portId)`, falling back to MacroDef.exposedInputs/Outputs for nested macros.

### Default Macros & Import/Export:
- `.gcamacro` file format: `{ schemaVersion: 1, name, description?, macroDef: MacroDef }`. Single MacroDef per file.
- `public/macros/*.gcamacro` is auto-indexed into `public/macros/index.json` by `macrosLibraryPlugin()` in vite.config.ts (mirrors `modelsLibraryPlugin`). Palette's "Default Macros" section fetches from `index.json` and lists each one as draggable.
- Right-click macro node → "Export Macro…" downloads a `.gcamacro` (filename derived from macro.name).
- Right-click canvas → "Import Macro…" (top-level item) opens a hidden `<input type="file">` and inserts the imported macro at the right-click position.
- `cloneMacroWithFreshIds(raw)` in `src/model/macroImport.ts` is REQUIRED for any macro import path. Regenerates: MacroDef.id, every internal node.id (with parentId remap), every edge.id, MacroPort.internalNodeId references, AND `config.macroDefId` on `macroInput`/`macroOutput` boundary nodes (this last one is easy to forget — without it, boundary nodes still point at the old MacroDef and macros break across imports).
- `importMacro(raw): string` action on ModelContext wraps clone + addMacro and returns the new id.
- MacroNode `data.label` is the user-facing name shown above the "Macro" header. `createMacroFromSelection` sets it; palette drops and file imports also pass `name` as the label argument to `addNodeAtPosition`. Always set the label when creating a macro instance.
- Project Macros section in palette filters `model.macroDefs` to only those referenced by at least one MacroNode (in `model.graphNodes` OR in any `model.macroDefs[*].nodes`). Stale defs (last instance deleted) don't appear; no auto-cleanup of model state itself.

### Undo Macro:
- Filters out boundary nodes and bridging edges when restoring
- Traces through bridging edges to find actual internal nodes for edge reconnection

### Macro Compilation (compile.ts):
- `inlineMacroValues()`: inlines value subgraph with `_m${macroNodeId}_` variable prefix
- `inlineMacroFlow()`: inlines flow chains, resolves control structures inside macros
- MacroInput ports → alias to outer upstream variables (no code emitted)
- MacroOutput inputs → `const _v${macroNodeId}_${portId} = <innerVar>;`
- Nested macros: `inlineNestedMacroValues()` chains prefixes (`_m${outer}_m${inner}_v${node}`)
- Recursion guard: tracks expanding MacroDef IDs in a Set, depth limit of 20
- Scoped scratch arrays: `_m${macroNodeId}_scr_${nodeId}` for GetNeighborsAttribute inside macros
- `scratchNodes` uses `{ scratchVarName, nbrId }` (not `{ nodeId, nbrId }`)

### Linked vs Independent Copies (v1.16):
- **The data model already supports sharing** — a macro instance is just a graph node whose `config.macroDefId` points at a `MacroDef`. Two instances sharing one `macroDefId` are **linked** (mirror copies): the MacroDef is the single source of truth (edit-inside writeback via `updateMacro`; all three compilers expand by `macroDefs.find(d => d.id === macroDefId)`), so editing any instance's internals updates ALL of them with **zero compiler changes**. Independent copies each own a separate MacroDef.
- **Creation paths (intentionally mixed):** Palette "Project Macro" drop = **linked** (reuses the existing `macroDefId`); right-click → **Duplicate → "Duplicate Linked"** = **linked**; right-click → **Duplicate → "Duplicate Independent"** + copy/paste + default-macro drop + Create-from-selection = **independent** (clone the def via `importMacro`/`cloneMacroWithFreshIds`).
- **`duplicateNode(linked = false)`** in [GraphEditor.tsx](src/modeler/vpl/GraphEditor.tsx): when `linked && srcType === 'macro'` it SKIPS the def-clone block so the duplicate keeps the source `macroDefId`. The single-node context menu renders **Duplicate as a hover submenu for macro nodes** (`.contextSubmenuTrigger`/`.contextSubmenu`, same pattern as Align/Distribute) — "Duplicate Independent" calls `duplicateNode(false)`, "Duplicate Linked" calls `duplicateNode(true)`. Non-macro nodes get a plain "Duplicate" button (`duplicateNode()` → independent). Don't pass `duplicateNode` directly as an `onClick` handler (the event would land in `linked`).
- **Count badge** ([CaNode.tsx](src/modeler/vpl/CaNode.tsx), `.linkBadge`): rendered as the first child of the macro `.header` (left of the "MACRO" title), shown ONLY when `countMacroInstances(model, macroDefId) >= 2` (Blender-style — single-user macros show nothing). Click → `.linkMenu` popover → **"Make Independent Copy"** = `importMacro(srcDef)` then `updateNodeData(id, {config:{macroDefId: newId}})` for THIS node only; other linked instances stay on the original (their count decrements). Keeps the node's `data.label` (no rename/suffix).
- **`nodrag` gotcha:** the badge + popover live in the `.header`, which is a React-Flow drag handle (only the `.body` carries the `nodrag` class). Interactive elements in the header MUST add the `nodrag` class or mousing down on them initiates a node drag — `onMouseDown` `stopPropagation` does NOT prevent it because React Flow's d3-drag attaches a native listener on the node element that fires before React's root-delegated handler. (`.linkBadge` + `.linkMenu` both carry `nodrag`.)
- **`countMacroInstances(model, macroDefId)`** in [macroImport.ts](src/model/macroImport.ts): walks `model.graphNodes` + every `model.macroDefs[*].nodes` counting macro instances with that `macroDefId`. Same traversal as the palette Project-Macros filter and `undoMacro`'s ref-check.
- **Undo asymmetry (accepted, harmless):** "Make Independent" does a model dispatch (`importMacro` → ADD_MACRO, sets `isDirty`) AND a graph-only node retarget. Ctrl+Z (graph-only history) reverts the retarget but leaves an **orphan MacroDef** — hidden from the palette (`usedMacroIds` filter) and never removed out from under a live instance by `undoMacro`'s ref-count. This exactly mirrors the existing independent-`duplicateNode` behavior. Don't build a combined ModelContext action (it would have to own React-Flow graph state).

### Remaining:
- No def-switching dropdown — a macro instance can't be repointed to a different existing MacroDef from the UI (only linked-copy / make-independent).

### Thumbnails
- `ModelProperties.thumbnail?: string` stores a PNG/JPEG/GIF/WebP data URL (≤2 MB, validated in `PropertiesPanelContent`). Travels inside `.gcaproj` — no sidecar for user-saved files.
- `modelsLibraryPlugin` in `vite.config.ts` extracts `properties.thumbnail` from each library `.gcaproj` into `<file>.thumb.<ext>` sidecars, records the sidecar path in `index.json`, and sweeps stale `*.thumb.*` on every run. Sidecars are gitignored (`public/models/*.thumb.{png,jpg,jpeg,gif,webp}`).
- Plugin runs only at `configureServer` / `closeBundle` — adding a thumbnail to a library `.gcaproj` while the dev server is running requires a restart before it shows up.
- `ModelsLibrary` renders a fixed-position 320×320 popover on `onMouseEnter`, positioned right-of-card (flips left when overflow), `image-rendering: pixelated` + `object-fit: contain` so small grid GIFs scale up crisply.

### UpdateAttribute Node
- Complements SetAttribute: in-place modify via increment/decrement/max/min (int/float), toggle/or/and (bool), next/previous (tag)
- Unary operations (toggle, next, previous) hide the `value` input port via `inputPorts.filter()` in CaNode.tsx
- Uses `w_${attr}[idx]` for read-modify-write (reads current write-buffer value, not read-buffer)
- Tag operations store `_tagLen` in node config for modulo wrap; updated when attribute selection changes

### Key Patterns:
- When adding new fields to CAModel type, always add migration guards in ModelContext's `createInitialState`
- `Attribute.boundaryValue?: string` (cell attrs only, shown in UI only when `properties.boundaryTreatment === 'constant'`). Worker's `buildNeighborIndices` writes `boundaryCellValue(attr) ?? defaultValue(attr)` into the sentinel cell at index `total`. WASM reads the same memory — no compile-path change needed.
- Align / Distribute submenu on the multi-selection context menu (`alignNodes(mode)` / `distributeNodes(axis)` in GraphEditor.tsx). Align modes: left/centerH/right, top/centerV/bottom. Distribute: sort by axis, fix first and last, equalize inter-node gaps. Uses the standard `pushCurrentSnapshot()` + `scheduleSync()` pattern.
- Node config UI: when a config field changes type (e.g., constType), reset dependent fields to prevent stale values
- Compiler: all value declarations hoisted to function scope (Pass 1) before control flow (Pass 2) to avoid block-scoping issues
- Web Worker in Vite: `new Worker(new URL('./file.ts', import.meta.url), { type: 'module' })` — no config needed
- Worker postMessage with transfer: use `{ transfer: [buffer] }` options format (not positional arg)
- ID generation: NEVER use counter-based IDs (`nextId++`) — they collide after page reload with saved models. Always use `Date.now().toString(36) + Math.random().toString(36).slice(2,5)`
- Worker message types: adding new messages requires updating the `WorkerMsg` union type in sim.worker.ts
- Vite base path: `base` must be conditional — `command === 'build' ? '/GenesisCA/' : '/'` — otherwise dev server fetches fail
- Randomize/Reset must run one step via compiled stepFn so model-defined color mappings apply (not hardcoded fallback)
- Models Library: Vite plugin in vite.config.ts auto-generates `models/index.json` from `public/models/*.gcaproj` — no manual manifest; card metadata comes from `ModelProperties`

---

## WASM Compile Target (Wave 2 — current default)

WASM is the default compile target for new models (`EMPTY_MODEL.properties.useWasm = true` in [defaultModel.ts](src/model/defaultModel.ts)). Full node-catalogue coverage including the multi-source `groupOperator.random` path. The Properties radio orders targets as **WebAssembly (default) / WebGPU / Debug & Reference (JS)**.

- 4-file structure under `src/modeler/vpl/compiler/wasm/`: `encoder.ts` (hand-rolled WASM binary encoder, no wabt.js), `layout.ts` (memory layout: attrs/colors/nbrs/modelAttrs/indicators/rngState/activeViewer/order/scratch), `emitter.ts` (`WasmEmitter` class + `ValueRef`/`ArrayRef` types), `compile.ts` (orchestrator + per-node emitters)
- One module exports all entry points: `step`, `inputColor_<sanitisedMappingId>`, `outputMapping_<sanitisedMappingId>`. `Math.pow` is imported as funcIdx 0 (JS provides via `env.pow`); sqrt/abs/floor use native f64 intrinsics
- Multi-output value cache: `valueLocals: Map<nodeId, Map<portId, LocalRef>>`. Single-output nodes get the named port aliased to `'value'` automatically; multi-output emitters call `setCachedPort` for each named port
- Array-producing nodes (`getNeighborIndexesByTags`, `filterNeighbors`, `joinNeighbors`, `getNeighborsAttrByIndexes`, `groupCounting` hybrid) live in a separate `ARRAY_NODE_EMITTERS` table. They allocate via per-cell scratch (bump-pointer reset at top of every cell iteration). Array consumers (aggregate/groupCounting/groupStatement) dispatch through `isArrayProducer` to the array path
- Entry-point nodes (inputColor/step/outputMapping) have NO `VALUE_NODE_EMITTERS` entry. InputColor's r/g/b outputs resolve via `paramRefs` map (function param indices 1/2/3); skipping them in `preEmitValueNodes` is required
- Skip `port.isArray` during scalar input resolution in `compileValueNode` / `compileArrayNode` / `compileFlowChain` — array consumers fetch sources via `inputToSources` + the array dispatch path; trying to value-emit an array source hits "no value emitter" errors
- Sync mode WASM↔JS interop: WASM uses baked-in `attrReadOffset`/`attrWriteOffset` so worker `runStep()` does pre-step `readAttrs→attrsA` normalize + post-step bulk `attrsB→attrsA` copy. JS-mode swap path is untouched. Same normalization needed in `paint`/`importImage`/`runColorPass` when WASM is active
- WASM compiler is self-sufficient — does its own `_resolvedTagIndexes` and `_indicatorIdx` pre-resolve (mirrors JS compiler). Don't assume the JS compiler ran first
- `window.__simWorker` is exposed in DEV (`SimulatorView.tsx`) for direct postMessage testing — far more reliable than standalone parity harnesses, which have subtle setup mismatches with the worker (activeViewer string vs i32, indicators Float64Array vs wasmMemory region, etc.)
- Big WASM-emitter refactors: implement EVERY emitter first, do a static review pass over the whole compiler, THEN run a single end-to-end test sweep. Iterative implement-test-fix-test cycles thrash because each new node type tested exposes structural issues (config-key mismatches, value-hoist scoping, sync-mode buffer swap, sentinel handling). One focused pass converges much faster
- Post-loop computation must stay in sync across JS and WASM targets. The JS-compiled step embeds post-loop aggregation (generated by `buildLinkedIndicatorCode` in `compiler/compile.ts`); the WASM step doesn't emit that code — instead the worker runs `computeLinkedIndicatorsFromBuffer()` after `wasmStepFn()` and replicates the aggregation against the shared typed-array buffer. Any new post-loop compute (new indicator kind, new metric, anything that reads the final-state buffer and writes to `linkedResults` / similar) needs both the JS-compile emit AND a matching branch in the worker-side fallback, or it'll silently work in JS mode and be empty in WASM mode.
- **Scratch-top snapshot for loop-invariant scratch allocations** (the Amphiphile NI-poisoning bug): `emitInvariantValueNodes` allocates scratch via `allocArrayInScratch`, which reads `scratchTopLocal`. But `scratchTopLocal` was only initialised inside `emitBody` (per-cell), so loop-invariant scratch allocations (e.g. a hoisted `getAllNeighborIndexes`) ran with the local at WASM's default 0 — their writes landed on top of the kind buffer at `memory[0..]`. Per-cell `getCellAttribute` reads then read NI bytes back as kind values, and `setNeighborAttributeByIndex` propagated the poison across cells until WASM eventually blew its memory bounds. Fix: seed `scratchTopLocal = layout.scratchOffset` BEFORE `emitInvariantValueNodes`, snapshot the post-invariant top into a new `perCellScratchBase` local, and reset per-cell scratch from `perCellScratchBase` (not the bare `scratchOffset` constant) so per-cell scratch starts ABOVE the invariant region. Models with no loop-invariant scratch are byte-identical (snapshot == `scratchOffset`). InputColor's single-shot entry seeds `perCellScratchBase = scratchOffset` directly (no invariant pass).

---

## WebGPU Compile Target (Wave 3)

**Status: functional.** WebGPU is the third compile target alongside JS (default) and WASM. The compiler emits a single WGSL shader module containing the `step` entry point + one `outputMapping_<sanitisedId>` per Attribute→Color mapping, dispatched as compute pipelines on the GPU. Verified on Game of Life (with macros), Coagulation, MNCA (model-attribute-driven trace gradient), and Wireworld (array-producing nodes + linked-frequency indicators) — paint, randomize, reset, play, save/load, indicator readback, stop events, GIF + WebM recording all work. Direct OffscreenCanvas render (transferControlToOffscreen + a `presentColors` compute pipeline) skips the per-step colors readback. GPU-side reductions cover eligible linked-indicator aggregations. Pipeline cache short-circuits rebuild when the WGSL source is byte-identical (`shaderHashOf` check at `sim.worker.ts:294`).

### Architecture
- `useWebGPU?: boolean` on `ModelProperties`. Mutually exclusive with `useWasm` enforced by the UI 3-way radio (Properties → Execution → Compile Target) and a worker-side safety net (WebGPU wins if both flags arrive true on a hand-edited file).
- `webgpuStopCheckInterval?: number` on `ModelProperties` (default 1) — opt-in throughput knob on WebGPU only. Worker checks the stop flag every K generations AND always on the last step of any batch (so the user never overshoots a stop event past the current play batch). K=1 preserves exact behaviour. JS / WASM ignore the setting.
- 4-file compiler under `src/modeler/vpl/compiler/webgpu/`:
  - `encoder.ts` — WGSL string helpers (bindings, struct decls, per-cell copy preamble, attr read/write helpers, PCG functions).
  - `layout.ts` — 8-binding GPU buffer layout (attrsRead/attrsWrite/colors/nbrOffsets/modelAttrs/indicators/rngState/control). Bool/int/tag/float attrs are stored as one u32 word per cell with bitcast on read/write. `nbrOffsets` holds only the per-neighbourhood (dRow, dCol) i32 pairs (a few KB total) — neighbour cell indices are computed inline by the WGSL `nbrCellIdx(cellIdx, baseOffset, k)` helper using grid-width/height/sentinel literals baked into each shader. Replaces the legacy per-cell `total × nbrSize` index table that hit multiple GB on huge grids (see docs/HUGE_GRID_OPTIMIZATIONS.md §2.1).
  - `emitter.ts` — `WgslEmitter` shell (legacy; current orchestrator builds lines directly).
  - `compile.ts` — orchestrator. Macro expansion (`expandMacros`) runs first to flatten the graph. Then `preEmitValueNodes` walks the flow chain to compile every referenced value node at the entry-point's top scope (avoids the "var declared in `if` branch but referenced in sibling `else` branch" WGSL scoping issue). Per-node dispatch via `VALUE_NODE_EMITTERS` and `FLOW_NODE_EMITTERS`.
- `src/simulator/engine/webgpuRuntime.ts` owns adapter/device/buffers/pipelines. `setupBuffersAndPipelines()` builds the step pipeline plus one pipeline per output mapping. Helpers: `uploadAttrs` / `uploadAttr`, `uploadNeighborOffsets`, `uploadModelAttrs`, `uploadActiveViewer`, `uploadIndicators`, `dispatchStep`, `dispatchOutputMapping`, `readbackAttrs`, `readbackColors`, `readbackIndicators`, `readbackStopFlag`, `seedRngState`.
- Worker integration:
  - `runStepWebGPU()`: resets stop flag, syncs per-generation indicators to GPU, dispatches step pipeline.
  - `runColorPassWebGPU()`: dispatches the active viewer's output mapping pipeline.
  - `finalizeStepWebGPU({needAttrs?, needColors?})`: async tail that reads back colors / indicators / stop flag (and optionally cell attrs for linked indicators or save state). Standalone integer/tag/bool indicators decode as bitcast<i32>; everything else as bitcast<f32>.
  - Mutation handlers (paint, importImage, randomize, reset, writeRegion, clearRegion) mutate CPU `readAttrs` then upload via `uploadAttrs` and dispatch `runColorPassWebGPU`.
  - `getState` does `readbackAttrs` first when `gpuOwnsAttrs`. `loadState` uploads everything after CPU restore.
  - On WebGPU init (`startWebGPUInit` then `setupBuffersAndPipelines`), the worker uploads CPU state, seeds per-cell RNG, dispatches an initial output mapping pass, reads back colors, and posts a `stepped` message so the canvas paints the initial state.

### Atomics
- Stop events: `atomicCompareExchangeWeak(&control.stopFlag, 0u, idxU)` — first-cell-wins matches JS/WASM semantics.
- UpdateIndicator (integer/tag): `atomicAdd` for increment/decrement, `atomicMax` / `atomicMin`. `bitcast<u32>(i32)` to encode.
- UpdateIndicator (bool): `atomicOr(&ind, 1u)` for `or` when value is true; `atomicAnd(&ind, 0u)` for `and` when value is false.
- UpdateIndicator (float): `loop { atomicLoad → bitcast<f32> → compute → bitcast<u32> → atomicCompareExchangeWeak; if exchanged break }`. CAS loop on the f32-bitcast u32 word.
- `toggle`/`next`/`previous` on indicators: rejected at compile time (order-dependent under parallel cell execution).

### Compile-time rejections
`detectWebGPUIncompatibilities()` and `detectWebGPUModelIncompatibilities()` in [nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts) catch async mode, the async-only nodes (`setNeighborhoodAttribute` / `setNeighborAttributeByIndex` / `markCellUpdated` / `setFacingOrientation` / `setNeighborOrientationByIndex` / `moveSelfToNeighbor`), and `updateIndicator` with `toggle`/`next`/`previous`. The variegated READ nodes + `setOrientation` + `lookupInteraction`/`interactionTableMap` + Init Event ARE supported on WebGPU. CaNode warning badges surface rejections in the modeler when `useWebGPU` is on. The compiler returns an `error` and the worker stays on JS.

### Not implemented on WebGPU (compile-time rejected, worker falls back to JS)
- `aggregate` / `groupOperator` with `op === 'median'` or `op === 'random'`. Use sum/product/min/max/average/and/or (or `weightedRandom`, which IS implemented), or switch target.
- Async update mode and async-only nodes (`setNeighborhoodAttribute`, `setNeighborAttributeByIndex`, `markCellUpdated`, `setFacingOrientation`, `setNeighborOrientationByIndex`, `moveSelfToNeighbor`).
- `updateIndicator` with `toggle` / `next` / `previous` (order-dependent under parallel cell execution).

### Known target-specific differences (intentional, documented)
- WGSL has no f64. Float arithmetic runs in f32 — small precision differences vs JS/WASM accumulate over many generations on chaotic models. Bit-exact parity is NOT a goal.
- RNG: WebGPU uses per-cell PCG state seeded from a global seed. JS/WASM use a single shared xorshift32 stream. Same global seed → different sequences. Statistical behaviour matches; deterministic replay across targets does not.

### Key gotchas
- WebGPU types are NOT in the default DOM lib. The project uses `@webgpu/types` (dev dep) referenced via `/// <reference types="@webgpu/types" />` at the top of `webgpuRuntime.ts` — do NOT add `"types": ["@webgpu/types"]` to tsconfig.app.json because that switches off auto-loading of all OTHER `@types/*` packages.
- WGSL struct definitions must come BEFORE the `var` declarations that reference them. `Control` struct is emitted before `var<...> control: Control` in `emitBindings()`.
- WGSL `var`/`let` are block-scoped. Cross-branch references (a value computed in `then` cannot be read in `else`) used to be solved by an eager `preEmitValueNodes` pass that hoisted every value to function-top scope. Post-sinking (see "Value sinking" section below) the analyzer guarantees every value's emit scope dominates all its uses, so block-scoped declarations inside an `if`/`case` block work naturally for single-branch values, and multi-branch values keep their LCA at the parent (function-top in the worst case) for cross-branch visibility.
- Storage buffers must be ≥4 bytes. `layout.ts` clamps `attrsBytes` / `nbrBytes` to a 4-byte minimum so degenerate models don't fail buffer creation.
- Worker-side mutual-exclusion safety net: in `init` and `setUseWasm`/`setUseWebGPU` handlers, when both flags would be true the worker silently demotes WASM. Keep both UI and worker enforcement — UI for live edits, worker for legacy `.gcaproj` files saved before the radio existed.
- `gpuOwnsAttrs = true` after `runStepWebGPU` runs. Mutation handlers AND save/load MUST upload-after-write OR readback-before-read. CRITICAL distinction: handlers that overwrite ALL cells (randomize, reset, importImage) call full `uploadAttrs(rt, readAttrs)`. Handlers that touch only a subset of cells (paint, writeRegion, clearRegion) MUST patch the GPU buffer at per-cell offsets via `device.queue.writeBuffer(attrsBuf, byteOffset + idx*4, ...)` — full `uploadAttrs` would clobber the post-Play evolved state with the stale CPU mirror. The bug symptom is "brushing seems to reset the board to random/initial".
- The Resize button (`handleApplyDimensions`) calls `initWorkerWithDimensions(w, h)` directly with the new dimensions WITHOUT updating `model.properties.gridWidth/Height`. The compilers must therefore receive a `dimsModel` with overridden dimensions — passing the unmodified `model` makes `compileGraphWebGPU` bake the OLD `total` into the WGSL bounds check (`idx >= ${total}u`), causing only the first N cells of the new larger buffer to evolve. WASM is tolerant because it takes `total` as a runtime function arg. Symptom: half the grid shows live evolution, half stays at the initial randomize.
- `adapter.requestDevice()` defaults to a conservative 128 MB `maxStorageBufferBindingSize` even when the adapter supports 2 GB. Large grids (multi-attribute models at 5000²+) can exceed the default for the attrs / colors buffers. Request `requiredLimits` matching the adapter's max so larger grids work. `setupBuffersAndPipelines` also defensively checks each region against the device's actual `maxStorageBufferBindingSize` and throws a clear error before the lower-level GPU validation error fires (which is hard to attribute back to a specific buffer). The neighbour-index buffer is no longer a concern post-§2.1 — it now stores only the relative offsets (a few KB total).
- DO NOT add fake/hardcoded "default viz" output shaders as placeholders for un-implemented per-node emit. The honest path: leave colors uninitialised on GPU, return a clear compile error, let the worker fall back to JS.
- Macros must be expanded BEFORE compile. `expandMacros` walks the graph, replaces each `macro` instance with the macroDef's internal nodes (prefixed ids) plus rewritten edges. Recursion guard depth=20 mirrors WASM. The compileValueNode / compileFlowChain code only sees flat post-expansion graphs.
- Vite serves stale dev-server modules aggressively when `@webgpu/types` arrives via reference. After heavy edits to the webgpu/ files, a hard reload is sometimes needed before the browser sees the new shader code.
- Under direct render, the visible canvas is `drawImage`'d from an OffscreenCanvas owned by the worker — main-thread `getImageData` on the visible canvas can return all-(0,0,0,0) even when the user sees content. Don't trust getImageData for verification under direct render; use `preview_screenshot` to read what the user actually sees.
- Soft-recompile direct-render: reusing the salvaged OffscreenCanvas across `startWebGPUInit`'s unconfigure+reconfigure-with-new-device leaves the canvas in a state where no subsequent `dispatchColorPassAndPresent` produces visible output (viewer switches and Play don't recover; manual Recompile button "works" only because it creates a fresh canvas via Phase 1/2). The main thread sets `recompilePendingCanvasRefresh.current = true` when sending a recompile under direct render; the useWebGPUStatus handler allocates a NEW canvas + `transferControlToOffscreen` + `attachCanvas` on the post-rebuild ack so Phase 2 commits a fresh canvas. Worker isn't torn down — all state survives.

---

## Value Sinking (cross-target compile optimisation)

All three compile targets share `src/modeler/vpl/compiler/sinkAnalysis.ts` — a target-independent analyzer that, for every value-producing node in a root's flow tree, computes the lowest-common-ancestor (LCA) of all its uses. Values used in exactly one switch case or if branch are emitted *inside* that branch; values used across multiple branches stay at the LCA (function-top in the worst case). The classic compiler-theory name is *lazy code motion* / *partial dead code elimination*.

### Why it matters
- Pre-sinking, every value-producing node referenced anywhere in the flow tree was emitted at cell-top regardless of which branch consumed it. On type-dispatch models (Wireworld, Predator-Prey, multi-species) most cells discarded most pre-computed values after the switch picked one case.
- Post-sinking, an Empty Wireworld cell (~80% of a sparse board) does one attribute read and skips the entire branch body — no filter loops, no scratch fills, no intermediate booleans.

### Flow graphs are DAGs, not trees
- A flow node CAN have multiple incoming flow edges (e.g., two switch cases targeting the same downstream Conditional). `compileFlowChain` in all three compilers (JS / WASM / WebGPU) has NO visited check — it inlines the flow node's body INLINE at every walking pass. The compiler is by design unaware that it's emitting the same body twice; the `compiled: Set` in `compileValueNode` (and analogous caches in WASM `valueLocals` / WebGPU `valueLocals`) dedupes value emission across the two walks.
- Any new flow-walk analysis must record value-input uses on every visit (not just the first) and treat the scope tree as path-dependent. The sink analyzer's `flowNodeContainingScopes` Map + `taintedSeed` post-process in [sinkAnalysis.ts](src/modeler/vpl/compiler/sinkAnalysis.ts) is the working template: track every parent scope a flow node was reached from, then climb out of "diamond-tainted" scopes (multi-parent flow nodes' bodies + containing scopes) when assigning emit locations.
- Editor connection validation prevents flow CYCLES but NOT flow diamonds (a flow input port can have multiple incoming edges). Both compilers and analyzers must tolerate diamonds.

### Iterating flow outputs / value inputs of a flow node
- `def.ports` only lists STATIC ports. Switch's `case_N` flow outputs and `case_N_cond` / `case_N_val` value inputs are DYNAMIC — they exist in the edge maps (`flowOutputToTargets`, `inputToSource`, `inputToSources`) but NOT in `def.ports`. Walkers that iterate `def.ports` will silently skip them.
- Correct pattern: iterate the edge map keyed by `${nodeId}:`. Examples: `collectValueDeps` in [compile.ts](src/modeler/vpl/compiler/compile.ts) walks ALL flow output edges via `for (const [key, targets] of flowOutputToTargets)` with prefix check; `recordValueInputs` in [sinkAnalysis.ts](src/modeler/vpl/compiler/sinkAnalysis.ts) walks dynamic value-input edges via the same prefix pattern after the static port iteration.

### Analyzer
- `analyzeSinkScopes({ nodes, edges, rootNodeId, rootFlowPortId })` walks the flow tree from the root, assigns each branch port (then/else/body/case_N/default) a `ScopeId`, then propagates use-scopes back through the value DAG to a worklist fixpoint. Sequence is transparent (no new scope). Switch with `caseCount === 0` and a default inlines the default at the parent scope.
- `recordValueInputs` walks BOTH static `def.ports` value inputs AND any dynamic-port edges from the same node (switch's `case_N_cond` / `case_N_val` live only in the edge map, not in static port lists). Without this the switch's per-case value-input sources would default to `CELL_TOP`.
- `hoistPastLoops` walks UP from each value's LCA past any Loop body and any ForEach body where the value isn't in that forEach's `elementDependents` transitive closure. Loops have a per-iteration recompute cost branches don't, so the LCA's "smallest scope where uses are dominated" rule would regress if a loop-invariant value landed inside a loop body. The hoist is conservative — for Loop nodes (no iteration-variable value output) we always hoist past; for ForEach we hoist past only when the value isn't element-dependent.

### Per-target consumption
- **JS** ([compile.ts](src/modeler/vpl/compiler/compile.ts)): `routeValueEmit` dispatches each value to either `valueLines` (CELL_TOP, current behaviour) or a per-scope `branchValueLines` buffer. `flushBranchValues` runs at every branch entry in `compileFlowChain` (conditional then/else, loop body, forEach body, switch case_N, switch default — both `firstMatchOnly=true` and the independent-cases mode). Lines are stored unindented and the flush applies the indent from the current flow-walk position, which sidesteps any drift between the analyzer's depth count and the emit indent. `collectValueDeps` walks ALL flow output edges (looked up via `flowOutputToTargets`) rather than static `def.ports`, so switch's dynamic case ports are reached during pre-emission.
- **WebGPU** ([webgpu/compile.ts](src/modeler/vpl/compiler/webgpu/compile.ts)): `routeEmissionForNode` wraps each value-/array-node emitter call in a buffer-swap — `ctx.lines` is replaced with a temporary array for the emitter's pushes, then captured lines route to `ctx.lines` (CELL_TOP) or `ctx.branchLines[scope]`. `flushBranchValues` runs at every branch entry. `preEmitValueNodes` still walks the flow tree to trigger compileValueNode for every referenced value before `compileFlowChain` runs — sinking changes WHERE the lines land, not WHETHER they're emitted. WGSL's block scoping then makes branch-local declarations work naturally for single-branch values.
- **WASM** ([wasm/compile.ts](src/modeler/vpl/compiler/wasm/compile.ts)): `emitValuesForScope(ctx, scope)` iterates `sinkAnalysis.valuesByScope[scope]` in topo order and calls `compileValueNode` / `compileArrayNode` for each. The bytecode lands at the current emit position — implicitly INSIDE the branch when called from inside an `emitter.ifThen` / `ifThenElse` / `loop` callback (WASM's structured control flow). No buffer-swap needed — WASM's emitter callbacks already enforce scoping for the bytecode they produce. The eager `preEmitValueNodes` pass was removed. WASM locals are still function-scope (only the `localSet` instruction sequence moves inside the branch); the per-cell scratch bump-pointer reset is unchanged because branches are mutually exclusive within a cell, so any branch's array-producing values get the full scratch budget from a fresh reset offset.

### Side-effect handling
- RNG-using nodes (`getRandom`, `pickRandomNeighbor`, `pickNRandomNeighbors`) participate in sinking. Cells that don't reach a branch with a getRandom don't burn RNG entropy. **Behaviour change for random-using models**: pre-sinking, every cell advanced the shared xorshift32 stream once per getRandom node per step; post-sinking, only cells whose path reaches the getRandom advance it. Models seeded prior to this change will produce different output starting at gen 1. JS↔WASM parity is preserved (both consume the same analyzer output and burn the RNG for the same cells). WebGPU uses per-cell PCG, so the change there is intrinsically per-cell (no cross-cell coupling either way).
- Scratch arrays (filterNeighbors, getNeighborsAttribute, etc.) reset their write head at use site (`.length = 0` in JS, `localSet $scratchTop, scratchStart` in WASM, `_len = 0` in WGSL). Sinking them is safe — the reset always precedes the fill within the value's emit.
- **Local-variable readers are exempt from sinking via the "volatile values" mechanism.** Any value transitively reading `getVariable` must NOT be sunk/hoisted — its inputs are mutated by `setVariable` / `setArrayElement` during the cell body (e.g. inside a `forEach`), so it must emit INLINE at the use site, after the mutating flow children. See the Local Variables → "Volatile values" section. This is a correctness override on top of sink analysis, lockstepped across JS / WASM / WebGPU.

### When sinking does NOT help
- Game of Life and similar models where every cell runs the same rule: nothing to sink. Compile output is unchanged.
- ProportionMap / Interpolation / arithmetic-only graphs without a switch or conditional: all values are at CELL_TOP regardless. Compile output is unchanged.
- Dense-mix workgroups on WebGPU: GPU divergence executes all touched branches with lane-masking, so per-cell wins from skipping a branch can be partially or fully absorbed by sibling-branch execution times. Sparse type-dispatch models (Wireworld) still win because most workgroups land on spatially-uniform regions.

### Gotchas
- The analyzer expects a **flat post-macro-expansion graph**. JS inlines macros during compile via `inlineMacroValues` / `inlineMacroFlow` — the analyzer therefore sees the macro instance as a single opaque value node and assigns it ONE emit scope; the macro's internal value nodes inherit by going through `routeValueEmit` themselves at the same scope when `inlineMacroValues` runs. WASM and WebGPU expand macros upfront (`expandMacros`) so the analyzer sees fully flat graphs.
- `compileRoot` (JS) takes raw `graphNodes` / `graphEdges` even though they're redundant with `nodeMap` etc. — the analyzer rebuilds adjacency internally, keeping it target-independent. Same pattern for WASM (`compileEntry` takes a precomputed `SinkAnalysisResult`) and WebGPU (`baseCtx.graphNodes` / `baseCtx.graphEdges` threaded through, analyzer called per-entry inside `compileEntry`).
- WebGPU's buffer-swap captures only the emitter's OWN push'es. Recursive `compileValueNode` calls for input sources have already routed their own emissions via their own wrappers, since inputs are resolved upstream of the wrapped emit call.

---

## Accessor CSE (cross-target compile optimisation)

All three compile targets run `canonicalizeAccessorEdges` from [accessorCSE.ts](src/modeler/vpl/compiler/accessorCSE.ts) before sink analysis. It computes a structural "purity key" for every value-producing node, groups nodes that share a key, picks one canonical per group (lexicographically smallest id), and rewrites consumer edges so non-canonical equivalents become unreachable. The downstream compilers (sink analysis, loop-invariance, fusion, per-target emit) see the dedup'd edges naturally — no per-target emit changes needed because all three lookup sources via `inputToSource` / `inputToSources`.

### Why it matters
- Lets users freely re-instance simple accessors in multi-equation graphs (Gray-Scott reaction-diffusion is the canonical case: each equation reads `u`, `v`, `∇²u`, `∇²v` — pre-CSE forced the user to either share one node and run cables everywhere, or pay 2× the read cost).
- Catches deeper duplicates too: `Compare(GetCellAttribute(u), GetConstant(3))` × 2 collapses all three pairs (the two compares, the two gets, the two constants), recursively.

### Purity rules
- **Impure (never canonicalised, each instance emits independently):** `getRandom`, `pickRandomNeighbor`, `pickNRandomNeighbors` (RNG side effect); `getIndicator` (`_indicators[id]` is mutable mid-cell via `SetIndicator`/`UpdateIndicator`); `aggregate` / `groupOperator` with `op === 'random'`; `macro` (opaque container — v1 doesn't introspect macro internals); entry-point types (`step`, `inputColor`, `initEvent`, `outputMapping`, `macroInput`, `macroOutput`).
- **Pure (CSE-eligible):** every other value-producing node, **provided every value input is also pure**. Impurity propagates through the key — `Compare(GetRandomA, k)` and `Compare(GetRandomB, k)` get different keys (even with identical configs) because the random source IDs differ in the `nonpure:<nodeId>:<port>` tag. Two consumers wired to the SAME `GetRandom` do canonicalise (they share the canonical key of that single source).

### Async-mode gate
- The pass is a no-op when `model.properties.updateMode === 'asynchronous'`. Async-mode Step shares one buffer, so a `GetCellAttribute` read can change after an intervening write within the same cell body — CSE would silently merge them, breaking the model. InputColor / OutputMapping / Init are individually safe to CSE in async mode (no in-loop mutation), but the global edge rewrite spans all roots, so the simplest sound design is "all-or-nothing per model".

### Per-target wiring
- **JS** ([compile.ts](src/modeler/vpl/compiler/compile.ts)): runs at the top of `compileGraph` right after async-validation, before `buildAdjacency`. Macros aren't pre-expanded in JS, so CSE only sees top-level nodes — fine because macros are impure anyway.
- **WASM** ([wasm/compile.ts](src/modeler/vpl/compiler/wasm/compile.ts)): runs AFTER `expandMacros`, so duplicate accessors inside (or across) macro instances also get merged.
- **WebGPU** ([webgpu/compile.ts](src/modeler/vpl/compiler/webgpu/compile.ts)): same — runs AFTER `expandMacros` on `expanded.edges` before `buildAdjacency`.

### Interaction with aggregate fusion
- `detectFusableConsumers` runs AFTER CSE on the rewritten edges. The common case (two `getNeighborsAttribute → aggregate` pipelines with identical inputs+op) merges into one pipeline that still has exactly one consumer → fuses normally.
- Corner-case regression: two `aggregate` nodes with DIFFERENT ops over the SAME `getNeighborsAttribute`. Pre-CSE: 2 fused gather+reduce loops (2 × N_nbr work). Post-CSE: 1 canonical scratch fill + 2 unfused reductions reading scratch (3 × N_nbr). Accepted as a v1 tradeoff — uncommon shape vs the broad Gray-Scott win.

### Gotchas
- `handleId` does NOT encode the source node id (`${kind}_${category}_${portId}` only) — CSE rewrites `edge.source` and leaves `sourceHandle` intact, which is sound because canonical and non-canonical share the same node TYPE → same port set.
- Vite dev-server module cache for `compile.ts` is sticky: editing the import line without restarting the dev server can leave the worker (which loaded the pre-edit module) emitting un-deduplicated code. Verify via a cache-bust import (`?t=Date.now()`) when smoke-testing fresh edits.
- The purity key serialises config minus underscored keys (`_resolvedTagIndex`, `_elemKind`, `_indicatorIdx`, etc.) — those are compiler-injected and derived from other config or graph structure, so structurally-identical nodes already match on the source keys that produced them. Adding a new user-facing config field needs no change here; adding a compiler-injected one should keep the leading-underscore convention.
- Dynamic value-input ports (`switch.case_N_cond` / `case_N_val`) aren't in `def.ports` — `purityKey` walks them from the edge map, same pattern as `sinkAnalysis.recordValueInputs`. Adding another dynamic-port node means it would benefit from CSE automatically as long as the dynamic ports follow the `${nodeId}:${portId}` edge-map convention.
- The pass is an O(N+E) edge-array rebuild. On Gray-Scott with ~12 duplicate accessors it shaves ~1 µs of compile time; even on huge models the cost is dominated by graph size, not CSE bookkeeping. No bypass flag.

### Behavioural changes you may see
- For seeded random models: pre-CSE, two `GetRandom` instances wired to the same Compare both advanced the shared `_rs` xorshift stream once per cell. CSE doesn't merge separate `GetRandom` instances (they're impure), so the RNG stream draws are unchanged. But: when two equivalent `Compare(GetRandom, …)` nodes are wired to a SHARED `GetRandom`, the redundant Compare collapses — only one branch evaluation per cell — and downstream branches that depended on this Compare's result see the same RNG draw. Models that incidentally relied on the duplicate emit (e.g., two Compare nodes each re-reading the same `GetRandom` output but bundled into different branches) won't see a behaviour change because both Compares read the SAME varname (`_v<random>`) anyway; CSE just folds the consumer.

---

## Variegated Cells (Directional Interactions) — opt-in feature, all three compile targets

Opt-in support for chemistry CA models where the interaction between two cells depends on **which face of one meets which face of the other** (water-aabb, micelle/bilayer formation, chirality, structured-solvent dynamics). Off by default; the Properties → Execution checkbox (`model.variegatedCells.enabled`) unlocks a dedicated sidebar panel, a per-cell orientation buffer, an Init Event entry-point, face-label palettes, and a set of orientation/face nodes. (The Lookup Table attribute type is available independently — a tag×tag table needs no variegation.) Models with the feature off behave byte-identically (the regions are stub-allocated).

### Single source of truth
- `src/modeler/vpl/compiler/variegation.ts` is shared by the JS/WASM/WebGPU compilers AND the worker runtime to prevent byte-level drift: `DIRECTION_TAGS` (`[N,NE,E,SE,S,SW,W,NW]`), `buildDirectionMap`, `buildFacePatternLookup` (palette-aware), `normalizeLookupTable(values, rowLabels, colLabels)` (rectangular), `resolveKeyLabels(source, model)`. Any new variegation math goes here, never inlined per-target.

### Orientation
- Per-cell **orientation** = 0–3 (0/90/180/270° clockwise rotation), auto-allocated when the feature is on. Defaults to 0; sentinel cell carries fixed boundary value 0.
- JS: `Int32Array` (`r_orientation` / `w_orientation`, sync-mode bulk-copy line in the step). WASM: i32/cell region in `wasmMemory` (read/write offsets in layout). WebGPU: co-located INSIDE the attrs buffer as one u32 word per cell appended after the cell-attr region, so the attrsBufA/B ping-pong swaps orientation read↔write for free.
- Orientation-reading nodes are `NEVER_INVARIANT` (loopInvariant.ts) so emits stay per-cell.

### Schema (all additive, no version bump)
- `CAModel.variegatedCells?: VariegatedCellsConfig` — `{ enabled, sourceAttributeId, facePalettes: FaceLabelPalette[], facePatterns: FacePattern[] }`. **Multiple palettes**: `FaceLabelPalette = { id, name, labels: string[] }`. Each species → one pattern → one palette, so `facePatternLookup` stays ONE species×8 Int32Array (built palette-aware in `buildFacePatternLookup`); `getFacingLabels` returns per-species-palette indices — no per-palette buffers.
- `FacePattern` — `{ id, name, paletteId, layoutMode, faces }`. Named 8-slot layout (N/NE/E/SE/S/SW/W/NW; edges-only disables the 4 corners) drawing labels from `paletteId`. Implicit `none` (index 0) covers unassigned slots + non-variegated neighbours.
- **Lookup Tables** (`AttributeType += 'lookupTable'`, renamed from `interactionTable`) — a (possibly **rectangular**) float matrix with independent `rowKeySource` + `colKeySource` (`LookupKeySource = { kind:'facePalette', paletteId } | { kind:'tagAttribute', attributeId }`). Face-palette axis labels = `['none', ...palette.labels]`; tag-attribute axis labels = the tag's `tagOptions` (no implicit none). A pure tag×tag table needs NO variegation. Row-major storage `row * colCount + col` (stride = colCount). `Attribute` fields: `rowKeySource?`/`colKeySource?`, `symmetric?` (only when both sources identical), `tableValues?` (sparse `rowLabel → colLabel → float`), plus `facePatternAssignments?` on the variegation source. `resolveKeyLabels(source, model)` (variegation.ts) is the single source of truth for axis labels+dim. Live-tunable via worker `updateLookupTable`. Migration `lookupTableMigration.ts` (LOAD_MODEL): `interactionTable`→`lookupTable`, `faceLabels`→`facePalettes[0]`, defaults both sources to that palette (square, preserves old behaviour).

### Node set (orientation/facing/face-label nodes gated by `requirements.variegated`; the two table nodes are NOT — they work with tag×tag tables sans faces)
- Readers (`data`): `getOrientation`, `getFacingOrientation` (neighbour you face in a config direction, no neighborhood), `getNeighborOrientationByIndex` (read-only, both modes), `getFacingLabels` (multi-output `myFaceLabel`/`theirFaceLabel`), `getAllFacingLabels` (8-slot Moore or 4-slot `cardinalsOnly`), `interactionTableMap` (label "Table Map"; vectorised lookup over parallel index arrays).
- Logic: `lookupInteraction` (label "Table Lookup"; index a Lookup Table by row+col → float; loop-invariant when both indices are).
- Writers (`output`): `setOrientation` (sync+async), `setFacingOrientation` (async-only), `setNeighborOrientationByIndex` (async-only). `moveSelfToNeighbor` requires variegated only when `transferOrientation`.
- `getConstant` gains a `faceLabel` constType (gated on variegated) with a `facePaletteId` selector — `preResolveVariegatedNodes` (compile.ts) bakes the face-label NAME into a compile-time index within the chosen palette (none=0; user labels 1-based). Same pre-resolve injects `_resolvedDirIdx`/`_resolvedDr`/`_resolvedDc` for facing nodes and per-table `_rowCount`/`_colCount` (col=stride) for `lookupInteraction`/`interactionTableMap`.

### Init Event entry-point (`initEvent`)
- Singleton entry-point that runs **once per cell on simulator Reset** (after defaults applied, before the first colour pass — NOT on Randomize or Load State). Outputs `x`, `y`, `maxX`, `maxY` + a `DO` flow chain. Useful beyond variegation: any procedural initial state (gradients, deterministic noise, random orientations). Compiled as a separate root (`compileGraph*` emit an `init` entry alongside `step`); worker `runInit` dispatches it before the first step. On all three targets — WASM exports `init`, WebGPU builds an init pipeline.

### Compile-target coverage
- **JS / WASM / WebGPU all lockstepped** (the older "WASM/WebGPU fall back to JS for variegated models" caveat is obsolete). Only `setFacingOrientation` / `setNeighborOrientationByIndex` stay rejected on WebGPU (async-only; WebGPU is sync-only). `detectWebGPUIncompatibilities` / `detectWasmIncompatibilities` enforce.
- WebGPU adds a 9th storage binding (`varAux`: facePatternLookup i32 + interaction tables as f32-bitcast-u32). Requires `maxStorageBuffersPerShaderStage` in `requiredLimits`; conservative adapters that cap at 8 fall back to JS.

### Cascade rules (ModelContext)
- 5 reducer actions: `UPDATE_VARIEGATED_CELLS`, `ADD/REMOVE/DUPLICATE/UPDATE_FACE_PATTERN`. Tag-option rename remaps `facePatternAssignments` keys; face-pattern delete clears assignments; deleting the variegation source attr clears `sourceAttributeId`; changing it away from tag detaches.

### Panel UX
- `ActivityBar` elides the **V** tab entirely when `variegatedCells.enabled` is false; `ModelerView` auto-switches the active panel to Properties if the user disables variegation while the V panel is open. `VariegatedCellsPanelContent` uses the canonical PanelContent.module.css primitives (source attribute selector, **multi-palette** Face Label Palettes editor, face-patterns list with a palette selector + 3×3 grid widget). `LookupTableEditor` (renamed from `InteractionTableEditor`, now takes `rowLabels`/`colLabels`) is shared between the Attributes panel (with row/col key-source pickers) and the simulator right panel.

### Gotchas
- The worker's `AttrDef` and SimulatorView's `init` message must carry the variegated payload (facePatternLookup + interaction tables + orientation) or the regions silently no-op. Interaction-table typed-array VIEWS over `wasmMemory` must be COPIED into, never reassigned (the usual view discipline).
- WGSL has no f64 — interaction-table math runs in f32 (intentional drift vs JS/WASM on chaotic models, same tradeoff as cell attrs). RNG differs (per-cell PCG on WebGPU vs shared xorshift32 on JS/WASM).
- Cell inspector publishes orientation as an extra row (`<int> (N/E/S/W)`) for variegated models.

### Amphiphile sample model + interaction-table presets
- `scripts/gen-amphiphile.mjs` programmatically builds `public/models/Amphiphile.gcaproj` (mirrors `gen-grayscott.mjs`), implementing the Kier book Example 5.3 move-into-empty rule: every non-empty cell rolls Bernoulli(P_break = ∏ P_B over neighbours), samples a direction by cumulative J-weighting over empty cardinals, moves atomically into the chosen empty cell; free amphis (all 4 cardinals empty) rotate uniformly. Re-running the script preserves any later-added `simulationState` + thumbnail in the existing output (like gen-grayscott). Showcases Variegated Cells + Local Variables + chemistry primitives end-to-end.
- `SimulationState.interactionTables?: Record<attrId, Record<row, Record<col, number>>>` extends presets to capture/restore lookup tables (field name kept for preset back-compat). `applySimulationState` restores them to BOTH the worker (`updateLookupTable`, with per-table resolved row/col labels) AND model state (`updateAttribute`), so the Properties panel + `.gcaproj` save reflect the preset. Amphiphile ships 9 presets (book Example 5.3 defaults + the 8 Kier 1996 Table I parameter sets).
- **`attrsStructurallyEqual` reinit guard** (worker, [SimulatorView.tsx](src/simulator/SimulatorView.tsx)): the model→worker reinit trigger compares only the fields the init layout depends on (id, type, isModelAttribute, defaultValue, boundaryValue, tagOptions, parentAttribute*/Values, undefinedValue, facePatternAssignments, neighborhoodHintId) — NOT reference equality on `model.attributes`, and NOT live-tunable fields (name, description, hasBounds/min/max, symmetric, tableValues). Without this, every `updateAttribute` (preset apply, Reset-to-Default, per-cell table edit) wiped the grid via full re-init. Latent bug, not just a preset prerequisite.

### Chromatography sample model (Kier, Cheng & Karnes 2000)
- `scripts/gen-chromatography.mjs` builds `public/models/Chromatography.gcaproj` (mirrors `gen-amphiphile.mjs`; same `node`/`vEdge`/`fEdge`/`groupNode` helpers + preserve-`simulationState`+thumbnail re-run tail). A 43×200 async column on a **FULL torus** — the paper's *"cylinder with ingredients flowing back to the top of the system"* (p.111) / *"on the surface of a torus to remove boundary conditions"* (p.21): `boundaryTreatment:'torus'` wraps BOTH axes — horizontal = the tube circumference, vertical = the gravity-driven mobile phase exits the bottom and re-enters the top, so it **recirculates as continuous flow**. Cell types `empty/W/B/S1/S2` (solvent / immobile stationary phase B / two solutes). **No variegation** — interactions depend only on the type PAIR, so `PB` (break) and `J` (join) are two `lookupTable` model attrs **keyed by `tagAttribute: cellType` on both axes** (the non-face Lookup Table path; `empty` rows/cols = 1, neutral). Move rule mirrors the Amphiphile's: gate (occupied AND not B ⇒ only W/S1/S2 move) → `forEachInArray` over the 4 cardinal NEAR neighbours filling `pbFactors[d]`=PB(my,nbr) and `weights[d]`=empty?J(my,far):0 (FAR = the 2-step extended-von-Neumann *k* cell) → Bernoulli(∏pbFactors) → hasA(empty) gate → `weightedRandom(weights)` → `moveSelfToNeighbor`.
- **TOPOLOGY — do NOT cap it (a fixed bug + the crux of the model).** An earlier build added immovable `wall` cells in the first/last rows to make a *closed* cylinder. That was WRONG: with no vertical recirculation, gravity drained every mobile cell to the bottom and the column ended up "just water at the bottom" (the user's bug report). The caps were borrowed from **Cheng & Kier 1995** (the oil-water paper), where two boundary rows DO turn the torus into a closed cylinder — but that model is a *shake-flask* where two liquids settle into static layers under a swap-gravity; it is NOT a flow-through column. The chromatography paper keeps the **full torus** precisely so the mobile phase recirculates. Verified post-fix (gen 350, WASM): W stays uniform ~0.69 across all 20 row-bands (no pooling), S1 (weak B-affinity) migrates to mean row ~53 while S2 (strong) lags at ~15 → two separated peaks.
- **Gravity** (Cheng & Kier 1995, JCICS 35:1054 — the cited oil-water paper defines gravity as a vertical SWAP ratio against the move-into-vacancy baseline P0; the chromatography paper simplifies it to ONE per-species term applied to all mobile components, *"the probability of a cell moving to a position further down the column"* = "the force pushing the mobile phase"): rendered as an additive `+G` on the SOUTH move-into-empty weight, on the same baseline scale as J. Implemented as a **post-loop OVERWRITE** of `weights[2]` using a CONSTANT index — two **JS-compile-only** hazards forced this exact shape (WASM tolerated both): (1) feeding the `forEachInArray` **index** into a compare/expression — rather than only into `arrayElement.position`/`setArrayElement.index` — gets that reader hoisted out of the loop by JS loop-invariance → runtime `_fei… is not defined`; (2) reading a SINGLE element of a Local-Variable array via `getVariable`+`arrayElement` (read-modify-write) tripped a `_v… is not defined` scoping bug. Overwriting `weights[2]` with a freshly-recomputed `empty?(J+G):0` (no variable read, constant index) is JS+WASM-safe and behaviourally identical to adding G inside the loop. **When generating Kier-style move models, keep the forEach index flowing only into array accessors.**
- **Chromatogram = the paper's Figure 3**: a linked **frequency spatial indicator** on `cellType` (`xAxis:'rows'`, `spatialBinMode:'absolute'`, `spatialBinSize:10`) with **`trackedValues:['S1','S2']`** so the chart shows ONLY the two solute curves — W/B/empty (which would otherwise dominate the shared Y-axis and flatten the solutes to ~0; `IndicatorSpatialChart` has no per-series hide) are filtered out at the worker's `sendColors` step. (Earlier builds used a `soluteId` sub-attribute + an Init-Event write + a `moveSelfToNeighbor` payload to achieve this; the general **Track Categories / `trackedValues`** indicator option replaced it — no extra attribute, no per-cell maintenance. See the Indicators §.) Colour view = a **linked categorical** output mapping on `cellType` (zero graph nodes).
- 17 presets (`interactionTables` PB+J + `modelAttrs.gravity`): Table 1 standard + Table 2 affinity (5, both solutes share the swept PB(SB)/J(SB)) + Table 4 flow-rate/gravity 2·5·10 (3) + Table 5 solvent polarity PB(WW)/J(WW) (3) + Table 6 stationary solvation PB(WB)/J(WB) (3) + Table 7 solute+stationary solvation (2). Async ⇒ JS/WASM only (WebGPU excluded by `moveSelfToNeighbor`); verified that S1 (weak B-affinity, PB 0.90/J 0.20) outruns S2 (strong, PB 0.10/J 2.00). The `initEvent` seeds a probabilistic injection band on row `INJECTION_ROW` (=2, a couple rows below the very top — keeps a solute from taking the one upward move that would wrap it to the column foot via the vertical torus, which would blot the chromatogram's far end; ≈10 S1 + 10 S2) and a W/B/empty bulk (≈69%/7%/24%) on every other row; B's "≥3 cells apart" constraint is not enforced.

---

## Chemistry Primitives (B.0 + B.1 + B.3 + GroupOperator.weightedRandom)

Additions on the `variegated_cells` branch that collapse the per-direction unroll typical of Kier-style chemistry CA models. Together they cut the Amphiphile example graph from 125 → ~109 nodes (175 → 137 edges), and the high-level structure now mirrors the book's pseudocode for the move-into-empty rule.

### B.0 — `cardinalsOnly` flag on `GetAllFacingLabels`
Optional config (default false). When true, the node emits 4-slot N/E/S/W arrays (cardinal directions only) instead of the default 8-slot Moore arrays. Slot indexing collapses 0/2/4/6 → 0/1/2/3. The face-rotation arithmetic still uses the Moore slot for lookup, but the OUTPUT arrays are 4-wide. Per-target: JS allocates `Int32Array(4)`, WASM allocates `4 × I32`, WebGPU `array<i32, 4>`. UI checkbox in CaNode. Book §2.3.6 P_B product naturally fits this — it's defined over Von Neumann (4 cardinals) not full Moore.

### B.1 — `InteractionTableMap` node
Vectorised `LookupInteraction` over parallel face-label arrays. Inputs: `myFaces` + `theirFaces` (parallel int arrays — typically the two outputs of `GetAllFacingLabels` in cardinals-only mode). Output: `values` (float array, length = min of input lengths). Replaces N scalar `LookupInteraction` chains with one node + one per-cell loop. Pair with `Aggregate.product` for the book's `P_break = ∏ P_B(myFace, theirFace)` formula. Registered as an `ARRAY_NODE_EMITTER` on all three targets. `requirements: { variegated: true }`.

### D.2 — `GroupOperator.weightedRandom` op (replaces standalone `SampleArrayByWeight`)
Cumulative-sum weighted sampling folded into the existing `GroupReduce` node alongside its sibling `random` (uniform) op. Treats the input array as weights; outputs `result` = picked weight, `index` (alias `position`) = picked index. Empty / zero-sum input → `index = -1`, `result = 0`. Always advances the shared RNG once (xorshift32 on JS/WASM, per-cell PCG on WebGPU) — same always-advance semantics as every other RNG-using node so cross-target branched control flow stays in step. FP-drift fallback picks the last index if numerical drift puts u >= sum.

The earlier standalone `SampleArrayByWeight` node was removed: the multi-source scalar variant exposed an invisible coupling (the SampleArrayByWeight's output `index` had no intrinsic order — it only worked when the same code wrote both the weight edges AND the consumer's index lookup, since edge order alone determined the implicit array order). `GroupOperator.weightedRandom` keeps the same operational shape (`values → result + position`, like uniform `random`) but its semantics demand a properly-ordered array source (or the same multi-source scalar convention Aggregate uses).

All three input shapes supported, mirroring Aggregate / the uniform `random` op:
- Single ArrayRef source (e.g. `InteractionTableMap → groupOperator.weightedRandom`) — the canonical chemistry pattern.
- Multi-source scalars (e.g. 4× per-direction `wt_d → groupOperator.weightedRandom`) — what the current Amphiphile uses pre-D.4.
- Single `getNeighborsAttribute` nbr-path source — materialises to a temporary array, then samples.

WASM emit lives in three sites paralleling the other groupOperator ops: `emitAggregateOrCount` (nbr-path), `emitArrayAggregate` (single ArrayRef), `emitScalarAggregate` (multi-source scalars). WebGPU emit lives at the top of `emitAggregateOrCount` and materialises all three input shapes through a unified post-fill path. JS emit is in `GroupOperatorNode.compile()` (standalone) plus `buildFusedGroupOperatorJS` (fused-nbr path).

### B.3 — `MoveSelfToNeighbor` node
Flow node that packages the atomic chemistry move-into-vacancy idiom. Static ports: `do` (flow input), `targetNI` (NI value), `orientation` (value, only shown when `transferOrientation` config is true). Dynamic per-slot value inputs `payload_${i}` driven by `payloadCount` config + per-slot `attr_${i}` config (which cell attribute to transfer). Emits, per slot: `w_attr[targetCell] = payload` then `w_attr[idx] = attr.defaultValue` (clear self to schema default). If `transferOrientation`: pushes orientation to target + clears self to 0.

Async-only (composes `setNeighborAttributeByIndex` writes which are async-only). WebGPU rejects via `detectWebGPUIncompatibilities`. Atomicity is intrinsic to SSA — payload values are snapshot at cell-top scope before any flow write fires, so the writes see the pre-move state even though the node executes them sequentially.

Pre-resolve (`preResolveMoveNodes` in `compile.ts`) bakes each slot's attribute defaultValue into `_attr_${i}_default` config (string), normalising `'true'`/`'false'` → `'1'`/`'0'` for typed-array compatibility. WASM emit reads `attr.defaultValue` directly via `getAttr(ctx.layout, attrId)`.

Dynamic-input port handling required adding edge-map iteration to BOTH the JS `compileFlowChain` and the WASM flow-input gathering (around the `flowEmitter()` dispatch). Previously only `def.ports` was iterated — Switch's `case_N_*` ports happened to be value-pre-emitted via a different path, but a leaf flow node like MoveSelfToNeighbor needs dynamic ports gathered into the `inputs` map. The pattern is now consistent across JS, WASM, and the sink analyzer.

CaNode UI: list of attribute-slot rows with dropdown + `−` button, `+ Slot` button, `Transfer Orientation` checkbox. Replaces the 5-node Amphiphile move sequence (sequence + 4 setters) with 1 node.

### Pre-resolve config injections (compile.ts)
`interactionTableMap` joins `lookupInteraction` in the variegation pre-resolve pass that injects per-table `_rowCount`/`_colCount` (col = row-major stride) resolved via the table's `rowKeySource`/`colKeySource` → `resolveKeyLabels(...).length`. JS-target only; WASM/WebGPU read per-table `ctx.layout.interactionTableOffsets[id].colCount` directly (the old single global `interactionTableLabelCount` is gone). The Lookup Table memory region is allocated whenever the model has any `lookupTable` model attr — independent of variegation (WASM `lookupTables` layout param; WebGPU varAux). JS emits the `_lookupTables` param when `variegated || hasLookupTables`.

### Behavioural notes
- `groupOperator.weightedRandom` always advances the RNG even on empty/zero-sum input. Models that relied on conditional RNG skipping would see different sequences — but no existing model uses this pattern (the op is new).
- InteractionTableMap is pure (CSE-eligible per `accessorCSE.ts`'s purity rules — it has no RNG, indicator reads, or write side-effects). `groupOperator.weightedRandom` is impure (RNG) — same as the existing `random` op. The accessor-CSE classifier already filters `groupOperator` instances by op name (any op === `'random'`), and the same filter covers `weightedRandom` automatically.
- `interactionTableMap` on a sub-attribute source: untested. The scalar `lookupInteraction` doesn't handle sub-attributes either (interaction tables are typically full model-attribute lookups). If users need sub-attribute-aware variants, file follow-up.

---

## Local Variables (schema-level feature, all three compile targets)

**Local Variables** are per-cell mutable scratch storage referenced by id across the graph. They let the user write rules as imperative pseudocode — "declare a value here, mutate it in a loop, read it elsewhere" — bridging the gap between GenesisCA's pure-dataflow model and the imperative style most CA rules are written in (e.g. "for each direction d, weights[d] = compute(d); then sample by weights").

### Lifetime + storage

- **Per-cell, per-step.** Each cell sees a fresh copy populated with `initialValue` at the start of its computation; mutations live only within that cell-step. No persistence across cells, no persistence across steps.
- **JS:** function-local in the compiled step. Array variables get ONE typed-array buffer allocated outside the cell loop (reused per cell) and refilled via `.fill(initialValue)` at cell-top. Scalar variables become per-cell `let _var_<id> = <init>;` declarations.
- **WASM:** ctx.variableLocals maps each variable to a slot. Scalars get a WASM function-local (`F64` for float, `I32` otherwise). Arrays get a function-local holding a scratch offset that's bumped each cell at cell-top (storage lives in per-cell scratch — fresh allocation, then unrolled fill with the initial value). `emitVariableStorage()` runs once at function entry; `emitVariableReset()` runs at cell-top inside `emitBody`.
- **WebGPU:** WGSL `var<function>` declarations at the top of every entry function (one shader invocation = one cell, so function scope is naturally per-cell). Scalars: `var<function> _var_X: T = init;`. Arrays: `var<function> _var_X: array<T, N>;` + unrolled init. WGSL types: i32 for bool/int/tag, f32 for float (no f64 in WGSL — same precision tradeoff as cell attrs).

### Schema (`Variable` in src/model/types.ts)

`{ id, name, description?, kind: 'scalar' | 'array', dataType: 'bool' | 'integer' | 'float' | 'tag', length?, initialValue, attributeId? }`. The `initialValue` string follows the same encoding as `Attribute.defaultValue` (bools as `"true"`/`"false"`, tag indices as `"0"`/`"1"`/..., numbers as decimal strings). For arrays, ALL elements reset to that one value (uniform fill — per-index init is a v1 limitation).

`model.variables` is the top-level array on CAModel. Cascade rules in ModelContext: removing the attribute a tag variable references demotes the variable to integer + clears `attributeId`; remapping the parent attr's `tagOptions` remaps the variable's `initialValue` via the same indexMap used for graph nodes; changing the attr's type away from tag also detaches.

### Three new node types

- **`getVariable`** (value): outputs the current value (scalar) OR the underlying typed array (array). Consumers iterate it like any other array source (Aggregate, GroupReduce, ArrayElement, ForEachInArray). Registered in BOTH `VALUE_NODE_EMITTERS` and `ARRAY_NODE_EMITTERS` on WASM and WebGPU — the dispatcher picks the right path based on the consumer's input port; the emitter errors out if the variable's kind doesn't match the dispatch path. Also listed in `isArrayProducer` on both backends so array consumers route correctly.
- **`setVariable`** (flow): assigns a value to a scalar variable. Validation rejects array variables (use SetArrayElement instead).
- **`setArrayElement`** (flow): writes `variable[index] = value` for array variables. Out-of-range writes silently skip — bounds-checked at runtime on all three targets (JS `if (i >= 0 && i < arr.length)`, WASM via `i32` compares wrapped in `ifThen`, WGSL via `if (i >= 0 && i < N)`).

### Loop-invariance gotcha (critical)

`getVariable` is on the `NEVER_INVARIANT` list in `loopInvariant.ts`. Without this, the composite rule classifies the GetVariable read (which has no value inputs) as vacuously invariant — and through it, every downstream consumer (Aggregate over the variable, GroupOperator over the variable, ArrayElement at the variable's chosen index). The hoist then emits the consumer chain at function scope BEFORE the cell loop runs and ANY writes happen. Symptom: `_rs` (declared just before the cell loop) is referenced in the hoisted weightedRandom emit (which uses RNG), producing `Cannot access '_rs' before initialization` at runtime. The fix is the entry in `NEVER_INVARIANT` — without it the model compiles but is silently broken for any variable used by a downstream aggregate.

### Volatile values (critical — the deeper mutation hazard)

`NEVER_INVARIANT` keeps the read per-cell, but a second hazard remains: **sink analysis** would still hoist a value like `aggregate.sum(getVariable(weights))` to scope-entry (above the `forEach` body that calls `setArrayElement(weights, …)`), so the aggregate reads the all-`initialValue` array before the loop populates it. Symptom (Amphiphile): `sumW` always 0 → `condCanMove` never fires → no cell ever moves, even though gen advances and counts are preserved. The fix is the **volatile-values** mechanism: nodes that transitively read `getVariable` bypass sink analysis and emit INLINE at the use site (the current `compileFlowChain` emit position, AFTER the mutating flow children have run).
- **JS** ([compile.ts](src/modeler/vpl/compiler/compile.ts)): a volatile-closure set; volatile nodes are skipped in the `collectValueDeps` pre-emit walk and re-emitted inline.
- **WASM** ([wasm/compile.ts](src/modeler/vpl/compiler/wasm/compile.ts)): `computeVolatileValueClosureWasm` marks the closure; `emitValuesForScope` skips them; consumer-side input resolution triggers `compileValueNode` lazily at the use site. ALSO: `getVariable` must be skipped in `emitValuesForScope`'s dual-dispatch — it's in both `VALUE_NODE_EMITTERS` and `ARRAY_NODE_EMITTERS`, so eager emission picks the wrong path and errors ("variable is array; wire to an isArray input…"), failing the WASM compile.
- **WebGPU** ([webgpu/compile.ts](src/modeler/vpl/compiler/webgpu/compile.ts)): same dual-dispatch skip in `preEmitValueNodes` for parity (Amphiphile is async so WebGPU rejects it, but other sync+variable models would hit the gap).
- Companion fix: `findElementDependents` (JS) and `elementDependentsByForEach` (sinkAnalysis) must seed the BFS with BOTH `forEach.element` AND `forEach.index` — Amphiphile's body indexes parallel arrays by `index`, so index-dependent values were wrongly hoisted out of the loop.

### ForEach.index — companion enhancement

`ForEachInArray` exposes a new `index` output port carrying the per-iteration loop counter. The compile plumbing was already there (`_fei<id>` in JS, `fi` in WASM-WebGPU local); just needed a port + a varName mapping in all three targets. Body-side nodes that need to index parallel arrays by slot (`kindsArr[d]`, `myFaceArr[d]`, etc.) read this instead of `element`. Amphiphile's per-direction loop body uses it heavily.

### Validation

- All three nodes require `variableId`. Missing config → warning badge.
- SetVariable rejects array-typed variables; SetArrayElement rejects scalar-typed.
- Local Variables now emit on **all three targets** (JS, WASM, WebGPU — see "Lifetime + storage" above for the per-target storage strategy). The earlier `detectWasmIncompatibilities` / `detectWebGPUIncompatibilities` guards that rejected the three nodes have been removed.

### Panel UI

`VariablesPanelSection` renders in the **Attributes tab** (moved there from Properties in Tier E — variables are per-cell scratch storage, which lines up with the cell/model-attribute mental model better than sitting under Indicators). A `.sectionHelp` line carries a short description under the section title. List + inspector (name, description, kind, dataType, length, initialValue, tag attribute for tag-typed variables, delete button). `+ Variable` adds a new variable with sensible defaults (scalar float, initialValue 0). Drag-to-canvas not supported in v1.

### Behavioural notes

- The `_var_<id>` JS local name uses a sanitised version of the variable id (`[^a-zA-Z0-9_]` → `_`). Stable across the GetVariable / SetVariable / SetArrayElement emit + the `variable.ts::variableLocalName` helper.
- Array length is fixed at compile time (the value of `length` config). Resizing the variable's length re-allocates the typed-array on the next recompile.
- The reset cost is ONE `.fill()` call per array variable per cell — V8 optimises this to a memset. Scalar variables cost one `let` per cell. Both are negligible compared to the work the cell rule does.
- On JS/WASM, variable decls are injected only into the `step` root (`buildVariableJS` is called inside the step compile; InputColor + OutputMapping don't get them). WebGPU's `emitVariableDeclsWgsl` runs at the top of every entry function (step/inputColor/outputMapping/initEvent) — a benign superset (dead decls if no variable node is reached there). If a future model needs variables in InputColor/OutputMapping on JS/WASM too, extend `buildVariableJS` / `emitVariableStorage` to those compile branches.

---

## Sub-Attributes (schema-level feature)

A **sub-attribute** is a cell attribute that's "only well-defined" on cells whose parent (Tag or Boolean) cell attribute holds one of a chosen set of values. Wireworld's `charge` only makes sense on Wire / Pulsar / Switch cells; sub-attributes encode this in the schema so the compiler injects parent-check guards automatically, and the graph never has to wire up manual filter-by-type chains.

### Schema

Three optional fields on `Attribute` (`src/model/types.ts`):
- `parentAttributeId?: string` — presence marks the attribute as a sub-attribute; references the parent cell attribute.
- `parentValues?: string[]` — encoded same as `defaultValue` (tag indices as `"0"`/`"1"`/..., bools as `"true"`/`"false"`).
- `undefinedValue?: string` — the value reads see when parent doesn't match.

The existing `defaultValue` plays a double role: init/randomize/reset value AND the value the copy-line / pre-scrub uses for non-matching cells between steps. Three fields total, all optional, all additive — old `.gcaproj` files load unchanged.

### Read semantics — context-dependent

- **Scalar reads** (`GetCellAttribute`, `GetNeighborAttributeByIndex` with a fixed index, `GetNeighborAttributeByTag`): the read emit wraps with `parent_matches(r_parent[idx]) ? raw_read : undefinedValue`. The user explicitly asked for ONE specific cell's value; they get a value either way.
- **Iteration contexts** (per-neighbor reads inside `GetNeighborsAttribute`, predicates inside `FilterNeighbors`, the per-element loop in `Aggregate`/`GroupOperator`/`GroupCounting` when fed from sub-attribute sources, and the worker's `computeLinkedIndicators` aggregation): non-matching cells are EXCLUDED from the iteration entirely. They don't appear in result arrays, predicates never evaluate them, aggregations skip them. The user's mental model is "a sub-attribute doesn't exist on cells where the parent doesn't match" — iteration treats those cells as if they weren't there.

### Write semantics

Writes ALWAYS proceed (rule a) regardless of parent. Storage at non-matching indices is invisible to reads (the guard returns `undefinedValue`), so "garbage" stored there is harmless. This sidesteps the order-of-writes hazard in async mode: a rule that writes `charge` before `cellType=Wire` in the same cell must not silently drop the charge write.

### Per-cell conditional copy (sync mode)

Both JS and WASM compilers emit a per-cell conditional copy at the top of the step loop body for sub-attributes: `w_subattr[i] = parent_matches(r_parent[i]) ? r_subattr[i] : defaultValue`. This:
- Auto-scrubs storage to `defaultValue` one step after a flip-OUT (parent transitions out of valid).
- Establishes a "starting point" for the cell rule. User writes (which happen later in the cell body) overwrite as needed, so order between `setAttribute(charge)` and `setAttribute(cellType)` doesn't matter.
- JS: in `compile.ts`, the bulk `cellAttrs.map(a => 'w_${a.id}.set(r_${a.id});')` skips sub-attrs; `subAttrSyncCopyLines` are injected at the top of the loop body instead. InputColor (per-cell, non-loop) uses the same conditional shape inline.
- WASM: `emitBulkCopyLines` skips sub-attrs (no bulk `memory.copy`); `emitBody` emits a `select`-based conditional copy at the top of each cell iteration for sub-attrs.

### Async-mode pre-scrub (worker)

Async mode shares a single buffer (`r_` and `w_` point at the same typed array), so the per-cell copy doesn't fit. Instead, `sim.worker.ts` runs `applySubAttributeAsyncScrub()` once per step before the cell loop: for each sub-attribute, set storage to `defaultValue` at indices where the parent's value isn't in `parentValues`. O(N) per sub-attribute per step.

### CompileContext (JS-target)

JS-target nodes that emit attribute reads call `ctx.readAttrExpr(attrId, idxExpr)` (5th arg on the `NodeTypeDef.compile` signature) instead of inlining `r_<id>[<idx>]`. For sub-attributes the helper emits the wrapped expression; for regular attributes it passes through. The matching `ctx.parentMatchesExpr` returns the iteration-skip predicate (or null for regular attrs). Helpers live in `src/modeler/vpl/compiler/subAttribute.ts` (target-independent core: `isSubAttribute`, `subAttrInfo`, plus JS-string emit helpers `attrValueLiteralJS`, `parentMatchExprJS`).

### Compile-target coverage

- **JS** — full support, scalar + iteration.
- **WASM** — full support across the whole node catalogue. All scalar reads, the per-cell sync conditional copy, and every iteration emitter (`aggregate`, `groupCounting`, `groupOperator` including `median`/`random`, `groupStatement` for allIs/noneIs/hasA/etc., `filterNeighbors`, `getNeighborsAttrByIndexes`) handle sub-attributes. For `aggregate.average` and `groupOperator.min`/`max` on sub-attrs, the WASM emit tracks a `matchCount` local so the post-divide uses the filtered count and `bestIdx` reports the position-in-filtered-set (matches JS semantics). Median materialises into per-cell scratch with parent-match filter, then sorts the filtered prefix. Random filters values into scratch and picks uniformly from the filtered length (RNG still advances on empty matches to mirror JS `Math.random()` semantics; empty filtered set returns 0).
- **WebGPU** — full support across the WebGPU subset of the catalogue (the general `aggregate.median` / `groupOperator.random` rejection still applies, regardless of sub-attr status, because the WGSL emit doesn't have a sort or random-pick path). Scalar reads use `select(undefined, raw, parent_match)` via `readAttrGuarded`. Iteration consumer loops (filterNeighbors, getNeighborsAttrByIndexes, aggregate/groupOperator/groupCounting/groupStatement nbr-path) inject `if (!parent_match) { continue; }`; for nbr-path aggregate, `matchCount` drives the average post-divide and `(matchCount - 1)` is the iterTag for groupOperator min/max (position-in-filtered-set, matching JS/WASM). Aggregate fusion is disabled when the source attribute is a sub-attribute (route through the materialised filter-with-push path instead). Per-cell conditional copy via WGSL `select(defaultWord, attrsRead[..], parent_match)` mirrors JS/WASM's sync copy line at the top of `step`. Sub-attribute linked indicators bypass the GPU reduction shader (LinkedDef.isSubAttribute) and route through the CPU `computeLinkedIndicatorsFromBuffer` path, which already applies the parent-match guard.

### Indicator aggregation

`computeLinkedIndicatorsFromBuffer` (sim.worker.ts) is an iteration context. For sub-attribute linked indicators, the per-cell loop prepends a parent-check guard — non-matching cells contribute to neither frequency buckets nor total sums. As a free upside, "total energy of predators"–style indicators become trivially expressible: mark `energy` as a sub-attribute of `creatureType` with `parentValues=[Predator]` and use a vanilla Total linked indicator on `energy`.

### Cascade behaviour

In `ModelContext` (`UPDATE_ATTRIBUTE` / `REMOVE_ATTRIBUTE` reducers):
- Deleting an attribute that's used as a sub-attribute's parent auto-detaches the dependents (clears `parentAttributeId` / `parentValues` / `undefinedValue` on each).
- Editing a parent's `tagOptions` remaps sub-attributes' `parentValues` (mirrors the existing tag-index remap for node configs). Tag entries whose names were removed are dropped from the set; surviving names are remapped to their new index.
- Changing a parent attribute's type AWAY from Tag/Bool auto-detaches dependents.

### Gotchas

- The worker's `AttrDef` must carry the three sub-attribute fields (`parentAttributeId`, `parentValues`, `undefinedValue`). SimulatorView's `init` message construction must include them or the async pre-scrub silently no-ops because `cellAttrs[i].parentAttributeId` is `undefined`.
- `scratchCtorForAttr` (JS compile.ts) returns `''` for sub-attributes — the scratch array must be a plain `Array` (not typed) so `GetNeighborsAttribute`'s filter-with-push pattern can call `.length = 0` and `.push()`. Typed arrays don't permit those operations.
- WASM `select` (opcode `0x1b`) pops `[a, b, cond]` and pushes `a` when `cond != 0`, else `b`. The emit pushes value-first, then undefined, then condition — so `cond=match`, `a=value`, `b=undefined`. Easy to flip if you're not careful.
- WGSL `select(falseValue, trueValue, cond)` is the OPPOSITE order from WASM `select`. Both targets emit conditional copy + scalar-read guards, but the literal argument order differs — `readAttrGuarded` emits `select(undefined, raw, match)` and the per-cell copy emits `select(defaultWord, attrsRead[..], match)`.
- WebGPU's `LinkedDef.isSubAttribute` must be set when building `linkedDefs` from the model. `buildReductionPlan` uses it to skip sub-attr indicators (CPU readback path applies the parent-match guard); without the flag, the reduction shader would aggregate over every cell and double-count the defaultValue bucket (sub-attr storage is scrubbed to defaultValue on non-matching cells by the sync copy line).

---

## Linked Output Mappings (schema-level feature, all three compile targets)

A quality-of-life feature that lets users **auto-generate** an Attribute→Color output mapping's color pass instead of hand-building the node graph — the on-ramp for newcomers who just want to *see* their model. Each A→C mapping (`isAttributeToColor`) has a **Color pass** mode:

- **Standalone** (classic): the user builds the color pass by hand (Output Mapping event node → … → Set Color Viewer).
- **Linked**: the user picks a cell attribute and the color pass is generated automatically — **bool** → two colors (default black/white); **float / integer** → a Color Scale spanning a user-set min/max (palette presets or hand-tuned stops); **tag** → one distinct color per option (categorical, no blending).
- **Override-after-background**: if the user *also* drops an Output Mapping node for a linked mapping, the auto pass runs **first** (a background coloring every cell), then the user's graph runs and overrides whichever cells it paints (special colors, glyphs). Both write the same `colors` buffer; within one OM function the LAST write wins.

### Architecture — synthesis, NOT per-target emit
The auto pass is produced by a **shared, target-agnostic pre-compile graph transform** that synthesizes **real nodes** (`getCellAttribute → colorScale | categoricalColor → setColorViewer`, rooted at an `outputMapping` node, sequenced via a `Sequence` node). All three compilers then reuse their existing per-node emitters — there is **no per-target color math** for linked mappings. This is the key reason the feature is low-risk: it rides the already-verified `colorScale` / `getCellAttribute` / `setColorViewer` / `sequence` emitters on JS/WASM/WebGPU.

- `src/modeler/vpl/compiler/linkedOutputMappings.ts` — `injectLinkedOutputMappings(graphNodes, graphEdges, model)` returns augmented `{ nodes, edges }`. Hot-path no-op when no linked mappings. Per linked mapping: synthesize the value chain + a terminal `setColorViewer`; if no user OM node exists, synthesize an `outputMapping` root → auto chain; if a user node exists with downstream, insert a `Sequence` (`first` = auto, `then` = the user's original target, preserving its target handle); user node with no downstream → wire root straight to the auto chain. Deterministic synthetic ids prefixed `__linkedOM_<mappingId>_`.
- **Per-compiler injection points** (all BEFORE accessor-CSE + `buildAdjacency`): JS `compileGraph` ([compile.ts](src/modeler/vpl/compiler/compile.ts)) — injected at the TOP, **before** the `graphNodes.length === 0` early return, so a linked-only model (no user nodes) still compiles; WASM `compileGraphWasm` and WebGPU `compileGraphWebGPU` — **after** `expandMacros`, before CSE. WebGPU MUST rebind the `const nodes` used by the OM-emission loop (`outputNodes.find(... mappingId ...); if (!root) continue;`) or it silently shows default colors while JS/WASM render.

### Freshness guarantee (no stale definitions)
The synthesized subgraph is **ephemeral** — never serialized, rebuilt from the *current* model on every recompile (and `SimulatorView`'s `useEffect([model])` recompiles on every model change). Only the small `Mapping.linked*` config persists. Two layers keep it sound: the ModelContext cascade (layer 1) + the transform's live resolve/guard/clamp (layer 2). The transform resolves the attribute live by id, branches on its live `type`, and (tag) clamps the palette to the live `tagOptions`, so a stale config can never emit a dangling read. Attribute **rename** needs no cascade (synthesis is id-based, never name-based).

### Schema ([types.ts](src/model/types.ts), all optional → old files load unchanged)
- `Mapping.linked?`, `linkedAttributeId?`, `linkedMin?`, `linkedMax?`, `linkedColors?: LinkedColorSet`.
- `ColorStop { position: number; r,g,b }` — gradient stop; `position` is in **[0,1]** (same space as the Color Scale node) and is mapped onto `[linkedMin, linkedMax]` at compile time (raw attribute value fed as `t`; ColorScale clamps outside the range).
- `LinkedColorSet { gradient?: ColorStop[]; method?: string; tag?: RGB[] }`. `gradient` covers bool (2 stops at 0/1) / float / integer; `method` is the interpolation curve; `tag` is per-option colors. Absent sub-fields → auto defaults generated by the transform.

### `categoricalColor` node ([CategoricalColorNode.ts](src/modeler/vpl/nodes/CategoricalColorNode.ts)) — the only NEW emitter
First-class, user-facing color node: input `index` (int), multi-output `r`/`g`/`b`, config `count` + `entry_<i>_(r|g|b)` + `default_(r|g|b)`. Emits an N-way integer-compare select (discrete lookup; contrast `colorScale` which interpolates). Used by the transform for tag attributes, and available for hand-built graphs. Registered in `MULTI_OUTPUT_TYPES` (compile.ts) + both WASM/WebGPU `VALUE_NODE_EMITTERS` (per-port `setCachedPort` is the multi-output registration). Pure → CSE-eligible by default. Config UI = palette editor in CaNode (`CategoricalColorEditor`). `readCategoricalEntries` / `readCategoricalDefault` are shared by all three emitters.

### Color Scale presets + shared editor
- `src/modeler/vpl/nodes/colorScalePresets.ts` — `COLOR_SCALE_PRESETS` (Grayscale, Viridis, Magma, Plasma, Inferno, Rainbow, Heat, Cool→Warm, Cividis) + `presetStops(name)`. Single source for both consumers.
- `src/modeler/vpl/widgets/GradientStopsEditor.tsx` — the gradient-bar editor (draggable stops + position/color/delete detail + Add Stop) **plus a preset dropdown**, extracted so it's reused by BOTH the Color Scale node (`ColorScaleEditor` is now a thin config↔stops wrapper) AND the linked float/integer editor. The linked editor adds the min/max Range + the Curve (`method`) dropdown for full parity with the node. Bool uses two pickers; tag uses per-option pickers. Defaults: float → Viridis, integer → Rainbow (via the transform's `defaultGradientStops`).

### Cascade ([ModelContext.tsx](src/model/ModelContext.tsx))
- `REMOVE_ATTRIBUTE`: unlinks any mapping linked to the deleted attribute (clears `linked*`).
- `UPDATE_ATTRIBUTE` type change: resets `linkedColors`/`linkedMin`/`linkedMax` (keeps the link) so a stale palette can't mismatch the new type — handled in both the tag/bool branch and the fall-through (covers float↔integer).
- `UPDATE_ATTRIBUTE` tagOptions change: remaps `linkedColors.tag[]` by the same `indexMap` (renamed/reordered keep their color, deleted drop out, new options get `defaultTagColor`).

### Gotchas
- Viewer tabs come from `model.mappings.filter(isAttributeToColor)` ([SimulatorView.tsx](src/simulator/SimulatorView.tsx)), so a linked mapping is selectable with no node placed; the worker dispatches the OM by `mappingId === activeViewer` exactly like a standalone OM (no new runtime path).
- `style={{ width: N, ...sharedStyle }}` foot-gun: if `sharedStyle` sets `width: '100%'`, the spread overrides the `N`. Put the override AFTER the spread (bit the GradientStopsEditor position input — kept the bar from squashing the color/delete controls).
- Inline-style overrides in shared widgets: the position spinbox is fixed-width + `flex: 0 0 auto`; the color input is `flex: 1`. Don't reintroduce `width: 100%` on the spinbox.
- A linked-only model with no Step node still hits the separate "No Step node" compile gate (the empty-graph reorder only covers the `length === 0` check). Realistic models always have a Step; relaxing the Step requirement is out of scope.


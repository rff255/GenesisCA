# GenesisCA — Project Context for Claude Code

## Repository Context

This repository (https://github.com/rff255/GenesisCA) originally contained a Qt/C++ desktop application built in 2017 as an undergrad final project (Universidade Federal de Pernambuco). The `legacy_qt_cpp_solution` branch preserves that legacy code — a qmake project with `src/modeler` and `src/simulator` subdirectories, DearImGui-based node editor, and C++ code generation for model export.

**The current work is a complete rewrite.** The legacy Qt/C++ code has been preserved in the `legacy_qt_cpp_solution` branch, frozen as historical reference. The new implementation is being developed on the `repo_overhaul` branch, which will eventually be merged into `master`. All legacy files (`.gitignore`, `.pro` files, `src/`, `third-party/`, etc.) have been removed on this branch — it starts clean with only this `CLAUDE.md` and the new project scaffolding.

The old implementation in `legacy_qt_cpp_solution` serves as architectural reference. Key file for understanding the old compilation approach: `src/modeler/UpdateRulesHandler/node_graph_instance.h` — each node had an `Eval()` method that emitted C++ code snippets, stitched together into `.h`/`.cpp` files, then compiled to `.dll`/`.exe`. The new version follows the same pattern but targets JavaScript instead of C++.

Active development lives on feature branches off `master` (most recently `improvements`). The `repo_overhaul` branch mentioned in older history was an early-rewrite checkpoint and is no longer the working branch.

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

### Graph → JS Compilation Strategy

This is the critical performance decision. At 5000×5000 (25M cells), the update function runs 25M times per generation.

**Approach: Compile the node graph to a JavaScript function string at edit time.**

Each node type defines a `compile()` method that emits a JS code snippet. The compiler:
1. Topologically sorts the graph
2. Resolves connections (output of node A → input of node B)
3. Stitches snippets into a flat function body with intermediate variables
4. Creates an executable function via `new Function(...)`

Example — a Game of Life graph compiles to a loop-wrapped step function (called ONCE per step, not per cell):
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
│   │       ├── nodes/                # 40 node types (one file each)
│   │       │   └── nodeValidation.ts  # detectMissingConfig() — drives warning badges
│   │       └── compiler/
│   │           └── compile.ts        # Two-pass compiler (hoisted values + flow)
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
│   │   ├── macroImport.ts            # cloneMacroWithFreshIds — ID regen for macro imports
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
- **Documentation consistency:** When changing features, update all three sources of truth: the code, `src/help/HelpView.tsx` (in-app Help tab), and the root `README.md`. For node-system changes (port types, redundancies, new nodes) also update `docs/NODES_REFERENCE.md` (table + Mermaid diagrams). These must remain consistent with each other.
- **Pre-commit type check:** Vite dev server does NOT type-check — always run `npx tsc -b` before committing to catch TypeScript errors that will fail the CI build. Note: `npx tsc --noEmit` (without `-b`) silently checks nothing because the root tsconfig has `"files": []` and only project references.
- **Debugging blank-screen React crashes:** When the app whites out (React unmounts on uncaught error), console usually only shows generic "error in `<X>` component" warnings without stack traces. Install a `window.onerror` handler via preview_eval BEFORE reproducing, then read captured errors after — this surfaces the real stack trace.
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
- No external compilation toolchains. The graph compiles to JS inside the browser instantly.
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
- `src/modeler/vpl/nodes/` — 40 node types, each in its own file with `compile()` method (2 are async-only: SetNeighborhoodAttribute, SetNeighborAttributeByIndex). Includes `StopEventNode` (flow input only, text widget for stop message — compiles to `if (_stopFlag[0] === 0) _stopFlag[0] = <1-based idx>;` first-match-wins; WASM emitter mirrors this via `i32.store` at `layout.stopFlagOffset`).
- Three "event" entry-point nodes: GenerationStep (per-gen logic), InputMapping C→A (brush), OutputMapping A→C (color pass)
- `src/modeler/vpl/compiler/compile.ts` — Two-pass compiler: hoists values, then emits flow
- Multi-output nodes (InputColor, GetColorConstant, MacroNode, ColorInterpolation) use `_v${nodeId}_${portId}` naming
- Switch node: flow control with dynamic case ports, compiler emits if/else-if chain
- Aggregate node: accepts multiple connections on one isArray input port, operations: Sum/Product/Max/Min/Average/Median
- ProportionMap, Interpolation, ColorInterpolation: math/color utility nodes
- GetNeighborAttributeByTag: resolves neighborhood cell tags to indices at compile time
- Multi-root support: Step (per-generation), InputColor (brush interaction), and OutputMapping (color pass) compile separately
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
- GIF recording: `gifenc` library, frame capture from srcCanvas in worker message handler, max 512px downscale
- Screenshot exports at display canvas resolution (not grid resolution) with nearest-neighbor upscale
- Recompile optimization: structural changes reinit worker, graph-only changes send `recompile` message (preserves grid state)
- Save/Load State: transport bar buttons (left side) save `.gcastate` / load `.gcastate`. Worker `getState` copies all typed arrays via `.slice()` and transfers them. Worker `loadState` restores arrays and rebuilds neighbor indices. `applySimulationState()` validates grid dimensions match before loading. Auto-save strips `simulationState` from localStorage to avoid quota overflow. Saving state also stores it in model context so next `.gcaproj` save includes it. On `.gcaproj` load, `pendingSimStateRestore` ref triggers restore after first worker `stepped` message.
- Save Project options: `genesis-capture-sim-state` CustomEvent carries `detail.include = { grid?: boolean; controls?: boolean }` (defaults to both true). SimulatorView resolves immediately when neither is wanted, or skips the worker round-trip for controls-only. All `SimulationState` fields are optional; `applySimulationState` restores grid and controls independently. When making new shared-serialized fields optional, also audit `readStateFile` validation and every consumer that reads them unconditionally.

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
- Async-only nodes (`ASYNC_ONLY_TYPES` in compile.ts): `setNeighborhoodAttribute`, `setNeighborAttributeByIndex` — compiler emits error if used in sync mode because copy lines overwrite neighbor writes. `getNeighborAttributeByIndex` is read-only and works in both modes. Both `setNeighborAttributeByIndex` and `getNeighborAttributeByIndex` accept an array index input (loops over all elements / takes element 0 respectively) — never coerce array→scalar via `(arr | 0)` because it silently returns 0 for any multi-element or empty array.
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
- Model element cleanup: `ModelContext.tsx` reducer uses `patchAllNodes()` / `clearDeletedId()` helpers to update node configs when attributes/neighborhoods/mappings/indicators are deleted. Tag option deletion remaps indices in getConstant, tagConstant, switch, and setAttribute nodes. Always scan both `graphNodes` and `macroDefs[*].nodes`.
- Graph nodes are heterogeneous: comment nodes (`type: 'commentNode'`) have `data: { text }` and group nodes have `data: { label, width, height, nodeType: 'group', config: {} }`. Any code iterating `model.graphNodes` must guard against `n.data.config` being undefined (e.g., `patchNodes` in ModelContext).
- Switch node: two modes (`conditions` = user-wired bool inputs per case; `value` = comparison ops per case with int/float/tag types). `firstMatchOnly` toggle: true = if/else-if chain, false = independent if blocks with `_sw{id}` guard variable. Tag mode uses equality against tag index; int/float mode uses configurable comparison op (==,!=,>,<,>=,<=).
- PanelShell `side` prop: `'left'` (default) puts resize handle on right edge; `'right'` puts it on left edge with inverted drag math. NodeExplorer uses `side="right"`. Simulator left panel has its own resize handle (`.leftPanelResizeHandle`).
- Show Code: `buildFullCode()` in SimulatorView concatenates step + all inputColor + all outputMapping functions with section headers. Uses mapping names for readability.

---

## Indicators (Implemented)

### Architecture:
- Two kinds: **Standalone** (typed scalar, graph-writable) and **Linked** (auto-computed from cell attributes)
- Standalone indicators support all types: bool, integer, float, tag — stored as JS numbers in `_indicators` object
- Linked indicators aggregate cell attribute arrays: Frequency (count per value) or Total (sum)
- Both kinds have Accumulation Mode: per-generation (reset each step) or accumulated (running total, reset on simulator reset)

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
- `linkedAccumulators` — running state for accumulated linked indicators
- Indicator values included in `stepped` message as `indicators: Record<string, number | Record<string, number>>`
- `initIndicators()` called on init, `resetIndicators()` on reset/randomize
- `updateIndicators` message rebuilds indicator state when definitions change

### Modeler UI:
- `IndicatorsPanelSection` component rendered inside `PropertiesPanelContent`
- Standalone: type selector, default value (type-specific), tag options editor
- Linked: attribute dropdown (cell attrs only), aggregation (type-dependent), bin count (float + frequency only)
- Both: accumulation mode radio, watched toggle, delete button

### Simulator UI:
- `IndicatorDisplay` component in right panel below brush controls
- Scalar values (standalone, linked total): single numeric display + sparkline chart (always-mount-wrapper pattern — see Key Patterns)
- Frequency maps (linked frequency): three viz modes cycled via a header button — **Bars** (`IndicatorDisplay` inline bar chart, current gen only), **Lines** (`IndicatorMultiLineChart`, one coloured line per category over time), **Stack** (`IndicatorStackedAreaChart`, cumulative-sum bands). Preference persists per indicator via `indicatorVizModes: Record<id, 'bars'|'multiline'|'stacked'>` inside `genesisca_sim_settings` localStorage.
- History shape in `SimulatorView.indicatorHistoryRef` is polymorphic: `number[]` for scalars, `Record<category, number[]>` for frequency maps. Capped at 500 samples per series.
- `chartExpandedRef` is populated by `IndicatorDisplay`'s render-phase ref-compare notification. Do NOT reset it in `initWorker`'s useEffect — that runs AFTER the child's render and wipes the populated set, so the first stepped messages collect no history (symptom: scalar sparklines stay blank until manual collapse/expand).
- Eye icon per indicator toggles `watched` state

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

### Remaining:
- Each macro instance is unique — no switching between definitions (macro dropdown removed)

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

## WASM Compile Target (Wave 2)

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

---

## WebGPU Compile Target (Wave 3)

**Status: functional.** WebGPU is the third compile target alongside JS (default) and WASM. The compiler emits a single WGSL shader module containing the `step` entry point + one `outputMapping_<sanitisedId>` per Attribute→Color mapping, dispatched as compute pipelines on the GPU. Verified on Game of Life (with macros) and Coagulation models — paint, randomize, reset, play, save/load, indicator readback, and stop events all work.

### Architecture
- `useWebGPU?: boolean` on `ModelProperties`. Mutually exclusive with `useWasm` enforced by the UI 3-way radio (Properties → Execution → Compile Target) and a worker-side safety net (WebGPU wins if both flags arrive true on a hand-edited file).
- 4-file compiler under `src/modeler/vpl/compiler/webgpu/`:
  - `encoder.ts` — WGSL string helpers (bindings, struct decls, per-cell copy preamble, attr read/write helpers, PCG functions).
  - `layout.ts` — 8-binding GPU buffer layout (attrsRead/attrsWrite/colors/nbrIndices/modelAttrs/indicators/rngState/control). Bool/int/tag/float attrs are stored as one u32 word per cell with bitcast on read/write.
  - `emitter.ts` — `WgslEmitter` shell (legacy; current orchestrator builds lines directly).
  - `compile.ts` — orchestrator. Macro expansion (`expandMacros`) runs first to flatten the graph. Then `preEmitValueNodes` walks the flow chain to compile every referenced value node at the entry-point's top scope (avoids the "var declared in `if` branch but referenced in sibling `else` branch" WGSL scoping issue). Per-node dispatch via `VALUE_NODE_EMITTERS` and `FLOW_NODE_EMITTERS`.
- `src/simulator/engine/webgpuRuntime.ts` owns adapter/device/buffers/pipelines. `setupBuffersAndPipelines()` builds the step pipeline plus one pipeline per output mapping. Helpers: `uploadAttrs` / `uploadAttr`, `uploadNeighborIndices`, `uploadModelAttrs`, `uploadActiveViewer`, `uploadIndicators`, `dispatchStep`, `dispatchOutputMapping`, `readbackAttrs`, `readbackColors`, `readbackIndicators`, `readbackStopFlag`, `seedRngState`.
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
`detectWebGPUIncompatibilities()` and `detectWebGPUModelIncompatibilities()` in [nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts) catch async mode, `setNeighborhoodAttribute` / `setNeighborAttributeByIndex` (async-only), and `updateIndicator` with `toggle`/`next`/`previous`. CaNode warning badges surface these in the modeler when `useWebGPU` is on. The compiler returns an `error` and the worker stays on JS.

### Not yet implemented (deferred, fall back to JS)
- Array-producing nodes: `getNeighborIndexesByTags`, `filterNeighbors`, `joinNeighbors`, `getNeighborsAttrByIndexes`. Models that use these (Wireworld, Gas Particles) compile-error and the worker stays on JS — surfaced via the existing error toast.
- `aggregate` / `groupOperator` with `op === 'median'` or `op === 'random'`. Use sum/product/min/max/average/and/or, or switch target.
- Direct OffscreenCanvas render. Currently colors are read back to CPU and posted via the existing `sendColors` path — works but does a per-step colors transfer. The headline perf optimisation is to transfer an OffscreenCanvas to the worker, configure it as the WebGPU output surface, and blit it via `displayCanvas.drawImage(srcCanvas, ...)` on the main thread.
- Pipeline cache. Currently the runtime rebuilds all pipelines on every recompile. The shader-source hash is computed (`rt.shaderHash`) but not yet checked.

### Known target-specific differences (intentional, documented)
- WGSL has no f64. Float arithmetic runs in f32 — small precision differences vs JS/WASM accumulate over many generations on chaotic models. Bit-exact parity is NOT a goal.
- RNG: WebGPU uses per-cell PCG state seeded from a global seed. JS/WASM use a single shared xorshift32 stream. Same global seed → different sequences. Statistical behaviour matches; deterministic replay across targets does not.

### Key gotchas
- WebGPU types are NOT in the default DOM lib. The project uses `@webgpu/types` (dev dep) referenced via `/// <reference types="@webgpu/types" />` at the top of `webgpuRuntime.ts` — do NOT add `"types": ["@webgpu/types"]` to tsconfig.app.json because that switches off auto-loading of all OTHER `@types/*` packages.
- WGSL struct definitions must come BEFORE the `var` declarations that reference them. `Control` struct is emitted before `var<...> control: Control` in `emitBindings()`.
- WGSL `var`/`let` are block-scoped. Pre-emit pass (`preEmitValueNodes`) is REQUIRED to keep value declarations at the entry-point's top scope so cross-branch references resolve. Without it, values cached during one branch's emission become unresolved in the sibling branch (`unresolved value '_acc2'`).
- Storage buffers must be ≥4 bytes. `layout.ts` clamps `attrsBytes` / `nbrBytes` to a 4-byte minimum so degenerate models don't fail buffer creation.
- Worker-side mutual-exclusion safety net: in `init` and `setUseWasm`/`setUseWebGPU` handlers, when both flags would be true the worker silently demotes WASM. Keep both UI and worker enforcement — UI for live edits, worker for legacy `.gcaproj` files saved before the radio existed.
- `gpuOwnsAttrs = true` after `runStepWebGPU` runs. Mutation handlers AND save/load MUST upload-after-write OR readback-before-read. CRITICAL distinction: handlers that overwrite ALL cells (randomize, reset, importImage) call full `uploadAttrs(rt, readAttrs)`. Handlers that touch only a subset of cells (paint, writeRegion, clearRegion) MUST patch the GPU buffer at per-cell offsets via `device.queue.writeBuffer(attrsBuf, byteOffset + idx*4, ...)` — full `uploadAttrs` would clobber the post-Play evolved state with the stale CPU mirror. The bug symptom is "brushing seems to reset the board to random/initial".
- The Resize button (`handleApplyDimensions`) calls `initWorkerWithDimensions(w, h)` directly with the new dimensions WITHOUT updating `model.properties.gridWidth/Height`. The compilers must therefore receive a `dimsModel` with overridden dimensions — passing the unmodified `model` makes `compileGraphWebGPU` bake the OLD `total` into the WGSL bounds check (`idx >= ${total}u`), causing only the first N cells of the new larger buffer to evolve. WASM is tolerant because it takes `total` as a runtime function arg. Symptom: half the grid shows live evolution, half stays at the initial randomize.
- `adapter.requestDevice()` defaults to a conservative 128 MB `maxStorageBufferBindingSize` even when the adapter supports 2 GB. Multi-neighbourhood models like MNCA at 500×500 have a 660 MB neighbour index buffer that exceeds the default. Request `requiredLimits` matching the adapter's max so larger grids work. `setupBuffersAndPipelines` also defensively checks each region against the device's actual `maxStorageBufferBindingSize` and throws a clear error before the lower-level GPU validation error fires (which is hard to attribute back to a specific buffer).
- DO NOT add fake/hardcoded "default viz" output shaders as placeholders for un-implemented per-node emit. The honest path: leave colors uninitialised on GPU, return a clear compile error, let the worker fall back to JS.
- Macros must be expanded BEFORE compile. `expandMacros` walks the graph, replaces each `macro` instance with the macroDef's internal nodes (prefixed ids) plus rewritten edges. Recursion guard depth=20 mirrors WASM. The compileValueNode / compileFlowChain code only sees flat post-expansion graphs.
- Vite serves stale dev-server modules aggressively when `@webgpu/types` arrives via reference. After heavy edits to the webgpu/ files, a hard reload is sometimes needed before the browser sees the new shader code.

---

## Future Work: List Attribute Type

List attributes (fixed-size arrays of a basic type per cell) were prototyped and removed. When re-implementing, watch for these pitfalls:

1. **SoA storage**: Each list attr with size K needs K separate typed arrays (`attrId_0` .. `attrId_K-1`). Every code path that iterates `cellAttrs` and accesses `readAttrs[attr.id]` / `writeAttrs[attr.id]` must expand list attrs into their sub-keys. Known locations:
   - `initGrid()` — create K arrays instead of 1
   - `randomizeGrid()` / `resetGrid()` — iterate sub-arrays
   - `buildLoopArgs()` / `buildCellArgs()` — push K arrays per list attr
   - **Paint handler** (`case 'paint'`) — copy-back loop after `icEntry.fn()` must copy each sub-key
   - **importImage handler** — same copy-back issue
   - **Constant boundary sentinel** (`buildNeighborIndices`) — must extend each sub-array by 1 for the sentinel cell
2. **Compiler**: `buildLoopParams` / `buildCellParams` must emit K params per list attr. `copyLines` / `icCopyLines` must copy each sub-array.
3. **Dynamic index access**: Emitting `[arr0,arr1,...][indexExpr]` works but the fallback for out-of-bounds must use `?? arr0` (nullish coalescing), NOT `|| [arr0]` which wraps the typed array in a JS array.
4. **Node types needed**: ListGetElement (value node) and ListSetElement (flow node) with attribute selector + index input. Store `listSize` in node config so the compiler knows expansion width.

# GenesisCA — Project Context for Claude Code

## Repository Context

This repository (https://github.com/rff255/GenesisCA) originally contained a Qt/C++ desktop application built in 2017 as an undergrad final project (Universidade Federal de Pernambuco). The `legacy_qt_cpp_solution` branch preserves that legacy code — a qmake project with `src/modeler` and `src/simulator` subdirectories, DearImGui-based node editor, and C++ code generation for model export.

**The current work is a complete rewrite.** The legacy Qt/C++ code has been preserved in the `legacy_qt_cpp_solution` branch, frozen as historical reference. The new implementation is being developed on the `repo_overhaul` branch, which will eventually be merged into `master`. All legacy files (`.gitignore`, `.pro` files, `src/`, `third-party/`, etc.) have been removed on this branch — it starts clean with only this `CLAUDE.md` and the new project scaffolding.

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
   - 1.1. Presentation (Name, Author, Goal, Description...)
   - 1.2. Structure (Topology, Boundary Treatment, Grid Size...)
   - 1.3. Execution
     - 1.3.1. Initial Configuration (Attribute Initialization Mapping, Default Attribute Values)
     - 1.3.2. Stop Conditions (Max of Iterations, Break Cases)

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

Users can save/load these files locally (browser download/upload). No cloud storage.

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
│   │   ├── ActivityBar.tsx           # Icon sidebar for panel switching
│   │   ├── PanelShell.tsx            # Panel wrapper (header + scrollable body)
│   │   ├── ModelerView.tsx
│   │   ├── panels/                   # Panel content components
│   │   │   ├── PropertiesPanelContent.tsx
│   │   │   ├── AttributesPanelContent.tsx
│   │   │   ├── NeighborhoodsPanelContent.tsx
│   │   │   └── MappingsPanelContent.tsx
│   │   └── vpl/                      # Visual Programming Language editor
│   │       ├── CaNode.tsx            # Custom React Flow node component
│   │       ├── types.ts              # Port/node type definitions
│   │       ├── GraphEditor.tsx
│   │       ├── graphState.ts          # Shared mutable state (avoids circular imports between GraphEditor/CaNode)
│   │       ├── NodeExplorer.tsx        # Right-side searchable node list panel
│   │       ├── nodes/                # 26 node types (one file each)
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
│   │   ├── defaultModel.ts           # EMPTY_MODEL (for New) + first-launch Game of Life auto-load
│   │   ├── fileOperations.ts         # .gcaproj save/load/download
│   │   ├── schema.ts
│   │   └── types.ts                  # TypeScript types for CAModel
│   └── export/                       # Presentation .html builder (planned)
├── public/
│   └── models/                       # Library .gcaproj files (index.json auto-generated by Vite plugin)
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
- **Documentation consistency:** When changing features, update all three sources of truth: the code, `src/help/HelpView.tsx` (in-app Help tab), and the root `README.md`. These must remain consistent with each other.
- **Pre-commit type check:** Vite dev server does NOT type-check — always run `npx tsc -b` before committing to catch TypeScript errors that will fail the CI build. Note: `npx tsc --noEmit` (without `-b`) silently checks nothing because the root tsconfig has `"files": []` and only project references.

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
- `src/model/defaultModel.ts` — Default Game of Life model
- `src/model/fileOperations.ts` — Save (.gcaproj) / Load / Download utilities
- localStorage auto-save with migration guards for new fields

### Visual Programming Language (VPL)
- `src/modeler/vpl/GraphEditor.tsx` — React Flow-based node graph editor
- `src/modeler/vpl/CaNode.tsx` — Custom node component with per-type config UI
- `src/modeler/vpl/nodes/` — 26 node types, each in its own file with `compile()` method (2 are async-only: SetNeighborhoodAttribute, SetNeighborAttributeByIndex)
- Three "event" entry-point nodes: GenerationStep (per-gen logic), InputMapping C→A (brush), OutputMapping A→C (color pass)
- `src/modeler/vpl/compiler/compile.ts` — Two-pass compiler: hoists values, then emits flow
- Multi-output nodes (InputColor, GetColorConstant, MacroNode) use `_v${nodeId}_${portId}` naming
- Multi-root support: Step (per-generation), InputColor (brush interaction), and OutputMapping (color pass) compile separately
- OutputMapping functions: loop-wrapped, always sequential (no shuffle), no copy lines; run once after all generation steps complete; skipped in unlimited gens mode via `skipColorPass` flag
- Paint with OutputMapping: prefers `runColorPass()` over `runStep()` so painting doesn't advance the simulation

### Simulation Engine (SoA Architecture)
- `src/simulator/engine/sim.worker.ts` — Web Worker owns grid as Structure of Arrays
- Grid storage: one typed array per attribute (`Uint8Array` bool, `Int32Array` int/tag, `Float64Array` float), double-buffered (sync) or single-buffer (async)
- Tag attributes: `Int32Array`, value = index into `tagOptions` string array
- Color model attributes: stored as 3 entries (`attrId_r`, `attrId_g`, `attrId_b`) in cachedModelAttrs
- Neighbor access: pre-computed `Int32Array` index tables (built at init, handles torus/constant boundary once)
- Step function is LOOP-WRAPPED: `(total, r_<attrs>..., w_<attrs>..., nIdx_<nbrs>..., nSz_<nbrs>..., modelAttrs, colors, activeViewer[, order])` — contains the for-loop, called ONCE per step
- Async mode: `order` param is an Int32Array of shuffled/random cell indices; loop uses `idx = order[_i]` instead of `idx = _i`; r_ and w_ params point to same typed arrays (single buffer); copy lines are skipped; buffer swap is skipped after step
- Async schemes: `random-order` (Fisher-Yates shuffle per step), `random-independent` (N random picks with replacement), `cyclic` (one-time shuffle at init)
- InputColor functions remain per-cell: `(_r, _g, _b, idx, r_<attrs>..., ...)`
- GetNeighborsAttribute uses `_scr_<nodeId>` scratch arrays declared before the loop — never allocate in hot path
- NEVER use `fn(...args)` in per-cell loops — V8 megamorphic spread kills performance
- Play pipeline chains from worker message handler (not rAF): receive result → draw → send next step
- Color output: SetColorViewer writes directly to RGBA buffer, checks `activeViewer` param for multi-viewer support
- Bool constants use `1`/`0` (not `true`/`false`) for typed array compatibility
- Paint: after InputColor writes to writeAttrs, copy back to readAttrs before runStep()
- `src/simulator/SimulatorView.tsx` — Canvas rendering via ImageData + zoom/pan, LMB=brush/RMB=pan
- Simulator settings persisted to localStorage (`genesisca_sim_settings`)
- Bottom transport bar: playback + speed sliders; top viewer bar: mapping tabs; collapsible side panels
- Keyboard shortcuts: Space=step (also pauses), Enter=play/pause, Esc=reset
- Brush cursor rectangle drawn on canvas; Ctrl+LMB drag to resize brush
- GIF recording: `gifenc` library, frame capture from srcCanvas in worker message handler, max 512px downscale
- Screenshot exports at display canvas resolution (not grid resolution) with nearest-neighbor upscale
- Recompile optimization: structural changes reinit worker, graph-only changes send `recompile` message (preserves grid state)

### Key Patterns
- Async-only nodes (`ASYNC_ONLY_TYPES` in compile.ts): `setNeighborhoodAttribute`, `setNeighborAttributeByIndex` — compiler emits error if used in sync mode because copy lines overwrite neighbor writes. `getNeighborAttributeByIndex` is read-only and works in both modes.
- Neighbor-write nodes use `if (_ni < total)` guard to protect constant-boundary sentinel from corruption
- Graph state sync: single debounced sync (100ms) via refs — never use multiple setTimeout callbacks
- Graph editor mouse: RMB click=context menu, RMB drag=pan (`panOnDrag={[2]}`), LMB click=select, LMB drag=box select (`selectionOnDrag`); simulator: LMB=brush, RMB=pan
- Shared mutable state: `graphState.ts` holds module-level variables (`isConnectingGlobal`, `showPortLabelsGlobal`, `connectingFrom`) to avoid circular imports between GraphEditor↔CaNode
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
- Use `NodeResizer` component for resizable nodes (comments, groups) — CSS `resize: both` conflicts with React Flow drag
- MacroNode, MacroInputNode, MacroOutputNode are hidden from Add Node menu via `HIDDEN_FROM_MENU` set
- Undo/redo: `graphHistory.ts` module-level undo/redo stacks (max 50 snapshots). Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo. Snapshot pushed BEFORE each mutation. History cleared on scope change.
- `isMultiOutput()` helper in compile.ts replaces raw `MULTI_OUTPUT_TYPES.has()` — also checks `getModelAttribute` with `isColorAttr` config
- CaNode config: NEVER call `updateConfig()` twice in sequence — second call uses stale `nodeData.config`, losing the first update. Instead, build the merged config object and call `updateNodeData(id, { ...nodeData, config: newConfig })` once.
- CSS gotcha: `flex: 1` on buttons inside flex-column containers causes them to stretch vertically. Remove `flex: 1` from buttons that should have fixed height.
- Nullish coalescing: never mix `??` with `||` or comparison operators without explicit parens — Babel/esbuild will warn or error.
- Simulator recompile: SimulatorView is conditionally rendered (unmounted on other tabs). Compilation happens automatically on mount via `useEffect([model, compileModel])`. No separate recompile effect needed — graph edits in Modeler are picked up when user switches to Simulator tab.
- Copy/paste: Ctrl+C/V/X + context menu. Module-level `clipboard` variable, strips macroInput/macroOutput, remaps IDs
- Group paste: parentId must be remapped to new IDs, children keep relative positions, groups sorted before children

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
- Scalar values (standalone, linked total): single numeric display
- Frequency maps (linked frequency): compact table with value→count rows
- Eye icon per indicator toggles `watched` state

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
- Selection highlight inconsistency — clicking nodes doesn't always show selection highlight reliably

### Key Patterns:
- When adding new fields to CAModel type, always add migration guards in ModelContext's `createInitialState`
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

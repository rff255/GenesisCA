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
4. Cells can only make changes to itself, never to the environment around (other cells)
5. Space and Time are discrete (cells arranged in n-dimensional grid)
6. All cells update their states simultaneously (synchronously) each passing generation

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

2. **Attributes** — each has a name, type (bool, integer, float, list, tag), description, and type-specific properties (integer range, list size, tag options...)
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
│   │       ├── nodes/                # 21 node types (one file each)
│   │       └── compiler/
│   │           └── compile.ts        # Two-pass compiler (hoisted values + flow)
│   ├── simulator/
│   │   ├── SimulatorView.tsx         # Canvas rendering, zoom/pan, brush tool
│   │   └── engine/
│   │       ├── SimEngine.ts          # Fallback engine (reference only)
│   │       └── sim.worker.ts         # Web Worker — owns grid, runs steps
│   ├── help/
│   │   └── HelpView.tsx              # In-app comprehensive Help tab
│   ├── library/
│   │   └── ModelsLibrary.tsx         # Models Library tab (fetches from public/models/)
│   ├── model/
│   │   ├── ModelContext.tsx           # React Context + useReducer
│   │   ├── defaultModel.ts           # Default Game of Life model
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
- All new work goes on `repo_overhaul` (to be merged into `master` when ready).

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
- `src/modeler/vpl/nodes/` — 21 node types, each in its own file with `compile()` method
- `src/modeler/vpl/compiler/compile.ts` — Two-pass compiler: hoists values, then emits flow
- Multi-output nodes (InputColor, GetColorConstant, MacroNode) use `_v${nodeId}_${portId}` naming
- Multi-root support: Step (per-generation) and InputColor (brush interaction) compile separately

### Simulation Engine (SoA Architecture)
- `src/simulator/engine/sim.worker.ts` — Web Worker owns grid as Structure of Arrays
- Grid storage: one typed array per attribute (`Uint8Array` bool, `Int32Array` int, `Float64Array` float), double-buffered
- Neighbor access: pre-computed `Int32Array` index tables (built at init, handles torus/constant boundary once)
- Step function is LOOP-WRAPPED: `(total, r_<attrs>..., w_<attrs>..., nIdx_<nbrs>..., nSz_<nbrs>..., modelAttrs, colors, activeViewer)` — contains the for-loop, called ONCE per step
- InputColor functions remain per-cell: `(_r, _g, _b, idx, r_<attrs>..., ...)`
- GetNeighborsAttribute uses `_scr_<nodeId>` scratch arrays declared before the loop — never allocate in hot path
- NEVER use `fn(...args)` in per-cell loops — V8 megamorphic spread kills performance
- Play pipeline chains from worker message handler (not rAF): receive result → draw → send next step
- Color output: SetColorViewer writes directly to RGBA buffer, checks `activeViewer` param for multi-viewer support
- Bool constants use `1`/`0` (not `true`/`false`) for typed array compatibility
- Paint: after InputColor writes to writeAttrs, copy back to readAttrs before runStep()
- `src/simulator/SimulatorView.tsx` — Canvas rendering via ImageData + zoom/pan, RMB=brush/LMB=pan

### Key Patterns
- Graph state sync: single debounced sync (100ms) via refs — never use multiple setTimeout callbacks
- Graph editor mouse: RMB click=context menu, RMB drag=pan (`panOnDrag={[2]}`), LMB click=select, LMB drag=box select (`selectionOnDrag`)
- Hide React Flow's persistent selection rect: CSS `:global(.react-flow__nodesselection-rect) { display: none !important; }`
- Groups use React Flow's native `parentId` — auto-resize requires manual bounding box computation in `handleNodesChange`
- Use `NodeResizer` component for resizable nodes (comments, groups) — CSS `resize: both` conflicts with React Flow drag
- MacroNode, MacroInputNode, MacroOutputNode are hidden from Add Node menu via `HIDDEN_FROM_MENU` set
- Copy/paste: Ctrl+C/V/X + context menu. Module-level `clipboard` variable, strips macroInput/macroOutput, remaps IDs
- Group paste: parentId must be remapped to new IDs, children keep relative positions, groups sorted before children

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

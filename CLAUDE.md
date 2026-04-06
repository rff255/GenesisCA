# GenesisCA — Project Context for Claude Code

## Repository Context

This repository (https://github.com/rff255/GenesisCA) originally contained a Qt/C++ desktop application built in 2017 as an undergrad final project (Universidade Federal de Pernambuco). The `legacy_qt_cpp_solution` branch preserves that legacy code — a qmake project with `src/modeler` and `src/simulator` subdirectories, DearImGui-based node editor, and C++ code generation for model export.

**The current work is a complete rewrite.** The legacy Qt/C++ code has been preserved in the `legacy_qt_cpp_solution` branch, frozen as historical reference. The new implementation is being developed on the `repo_overhaul` branch, which will eventually be merged into `master`. All legacy files (`.gitignore`, `.pro` files, `src/`, `third-party/`, etc.) have been removed on this branch — it starts clean with only this `CLAUDE.md` and the new project scaffolding.

The old implementation in `legacy_qt_cpp_solution` serves as architectural reference. Key file for understanding the old compilation approach: `src/modeler/UpdateRulesHandler/node_graph_instance.h` — each node had an `Eval()` method that emitted C++ code snippets, stitched together into `.h`/`.cpp` files, then compiled to `.dll`/`.exe`. The new version follows the same pattern but targets JavaScript instead of C++.

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

Example — a Game of Life graph compiles to:
```js
(cell, neighbors, modelAttrs) => {
  const _v0 = neighbors.reduce((s, n) => s + n.alive, 0);
  const _v1 = (_v0 === 3);
  const _v2 = (_v0 === 2);
  const _v3 = (cell.alive && _v2);
  const _v4 = (_v1 || _v3);
  return { alive: _v4 };
}
```

This mirrors exactly how the old Genesis worked — each node's `Eval()` produced C++ code, stitched into `.h`/`.cpp`, compiled by gcc into `.dll`/`.exe`. The only difference: the target language is JS instead of C++, and compilation is instant (no external toolchain).

**Why not interpret the graph at runtime:** At 25M cells, even ~2μs overhead per cell = ~50 seconds per generation. Compiled JS with JIT optimization targets ~10-50ns per cell = ~0.25-1.25s per generation.

A "debug/step mode" that interprets the graph slowly with visual feedback (highlighting active nodes, showing intermediate values) is planned for when users are designing — then switch to compiled mode for simulation runs.

### Model File Format

Models are saved as `.genesis.json` files with a versioned schema. The JSON contains:
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
├── CLAUDE.md              # This file
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── public/
├── src/
│   ├── App.tsx
│   ├── modeler/           # Model editing UI
│   │   ├── PropertiesPanel.tsx
│   │   ├── AttributesPanel.tsx
│   │   ├── NeighborhoodsPanel.tsx
│   │   ├── MappingsPanel.tsx
│   │   └── vpl/           # Visual Programming Language editor
│   │       ├── nodes/     # One file per node type (Add, IfThenElse, GetAttribute, NeighborhoodSum, etc.)
│   │       ├── compiler/  # Graph → JS compilation logic
│   │       └── GraphEditor.tsx
│   ├── simulator/
│   │   ├── engine/        # Web Worker: simulation loop, grid state management
│   │   ├── renderer/      # Canvas2D rendering (later WebGPU)
│   │   └── SimulatorView.tsx
│   ├── model/
│   │   ├── schema.ts      # Model JSON schema definition + version migrations
│   │   └── types.ts       # TypeScript type definitions for the model
│   └── export/            # Presentation .html builder
```

---

## Development Guidelines

- Language: TypeScript (strict mode)
- All new code and documentation in English
- The original undergrad thesis (in Portuguese) exists as reference material but is not part of the codebase
- Prefer modular, readable code. Each node type is its own file. The compiler is separate from the editor.
- Do not assume file structure beyond what's documented here — ask if uncertain
- When building new node types, follow the established pattern of existing nodes (compile method, port definitions, UI component)

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
- `src/modeler/vpl/nodes/` — 19 node types, each in its own file with `compile()` method
- `src/modeler/vpl/compiler/compile.ts` — Two-pass compiler: hoists values, then emits flow
- Multi-output nodes (InputColor, GetColorConstant) use `_v${nodeId}_${portId}` naming
- Multi-root support: Step (per-generation) and InputColor (brush interaction) compile separately

### Simulation Engine
- `src/simulator/engine/sim.worker.ts` — Web Worker that owns grid state
- Grid never leaves the worker — only RGBA color buffer is transferred (zero-copy via Transferable)
- Double-buffered grids, cached neighbor arrays, pre-allocated output objects
- `src/simulator/SimulatorView.tsx` — Canvas rendering via ImageData + zoom/pan

### Key Patterns
- Graph state sync: single debounced sync (100ms) via refs — never use multiple setTimeout callbacks
- When adding new fields to CAModel type, always add migration guards in ModelContext's `createInitialState`
- Node config UI: when a config field changes type (e.g., constType), reset dependent fields to prevent stale values
- Compiler: all value declarations hoisted to function scope (Pass 1) before control flow (Pass 2) to avoid block-scoping issues
- Web Worker in Vite: `new Worker(new URL('./file.ts', import.meta.url), { type: 'module' })` — no config needed
- Worker postMessage with transfer: use `{ transfer: [buffer] }` options format (not positional arg)

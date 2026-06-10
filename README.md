# GenesisCA <sup>v1.17.3</sup>

An IDE for modeling and simulating Cellular Automata, built as a self-contained browser application.

**[Launch GenesisCA](https://rff255.github.io/GenesisCA/)** — runs entirely in your browser, no installation required.

---

## What GenesisCA Is

GenesisCA is an IDE for modeling and simulating Cellular Automata (CA). It uses a Visual Programming Language (VPL) — a node-based graph editor — so users can design arbitrarily complex CA models without writing code. The goals are **accessibility** (no programming required) and **performance** (compiles WASM and even WebGPU for synchronous models).

> Everything runs 100% client-side — no server, no sign-up, no paid hosting.

Originally implemented in C++/Qt/DearImgui as an undergraduate final project at the Universidade Federal de Pernambuco (UFPE, Brazil) in 2017 (See historical branch `legacy_qt_cpp_solution`), the application has been completely rewritten as the free modern web application it is today.

---

## Overview

### **Modeler**
Visual programming graph editor with node-based update rules, and panel with total freedom to define any and how many cell attributes; neighborhoods; and mappings to/from colors from/to cell attributes:
![Modeler](docs/Gifs/modeler.gif)

### **Simulator**
Real-time visualization with parameter controls; cell inspector; copy/paste selection; brush/image input; enabling saving of full grid state; recording gifs/videos; and taking screenshots:
![Simulator](docs/Gifs/simulator.gif)

### **Models Library**
Pre-made models to explore and learn from. Enabling users to build upon classical or innovative models:
![Library](docs/Gifs/model_library.gif)

### **In-app Help**
Detailed in-app help tab with a comprehensive tutorial and reference material regarding features, usage, shortcuts and such:
![Library](docs/Gifs/help.gif)

### **Example**
Gray-Scott Reaction-Diffusion model `[Peter Gray & Stephen K. Scott (1983)]`:
![Library](docs/Gifs/gray-scott.gif)

**Other**

<table>
  <tr>
    <td align="center" width="25%"><img src="docs/screenshots/elementary_1d_ca_rule90.png" width="100%"/><br/><sub>1D Elementary CA — Rule 90</sub></td>
    <td align="center" width="25%"><img src="docs/Gifs/wireworld.gif" width="100%"/><br/><sub>Wireworld (expanded)</sub></td>
    <td align="center" width="25%"><img src="docs/screenshots/grayscott.png" width="100%"/><br/><sub>Gray-Scott (still)</sub></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="docs/screenshots/game_of_life.png" width="100%"/><br/><sub>Game of Life</sub></td>
    <td align="center" width="25%"><img src="docs/screenshots/coagulation.png" width="100%"/><br/><sub>Coagulation</sub></td>
    <td align="center" width="25%"><img src="docs/screenshots/elementary_1d_ca_rule110.png" width="100%"/><br/><sub>1D Elementary CA — Rule 110</sub></td>
  </tr>
</table>

---

## The GenesisCA Model Definition

### Six Fundamentals

Every GenesisCA model satisfies these theoretical properties:

1. Cells have unlimited computing power
2. Cells have N internal attributes (of multiple data types), whose snapshot of values at a given generation is called its "state"
3. Cells are limited to only access (read) the states of cells in one of the neighborhoods defined in the CA model
4. **Writability** — In synchronous (classic) mode, cells can only modify their own attributes. In asynchronous mode, cells can also directly modify the attributes of neighboring cells, enabling movement and mass-conservation rules.
5. Space and Time are discrete (cells arranged in n-dimensional grid)
6. **Synchronicity** — Model can be either synchronous (all cells update simultaneously — classic CA) or asynchronous (cells update sequentially, enabling number-conserving models)

### Simulation Essentials (Color Mappings)

Beyond the six fundamentals, two types of mappings enable visualization and interaction:

1. **Attribute-Color Mappings** — N ways to map cell state → colors (for visualization)
2. **Color-Attribute Mappings** — N ways to map colors → cell state (for user interaction and image-based initialization)

### Model Structure

A complete GenesisCA model definition consists of:

1. **Model Properties**
   - 1.1. Presentation (Name, Rule Author, GenesisCA Project Author, Description, Tags)
   - 1.2. Structure (Topology, Boundary Treatment, Grid Size)
   - 1.3. Execution (Update Mode, optional End Conditions: max generations + indicator rules)

2. **Attributes** — each has a name, type (bool, integer, float, tag, color, NeighborIndex), description, and a default value
   - 2.1. Cell Attributes (per-cell state) — including NeighborIndex for cells that point at one of their neighbors (movement direction, leader-follower, etc.). Cell attributes can also be marked as **sub-attributes** — only well-defined when a parent (Tag or Bool) cell attribute is in a chosen value set, e.g. *charge* defined only on Wire (wireworld model). The compiler auto-injects parent-check guards at every read site so rules express "count head-charges around me" directly, with no manual filter-by-type chains
   - 2.2. Model Attributes (global parameters that all cells can read but not write; adjustable at runtime in the Simulator)

3. **Neighborhoods** — a list of neighborhoods, each being a list of relative offsets from the central cell (margin up to 20), optionally including the central cell (`[0,0]`) itself

4. **Color Mappings** — each mapping has a Name, Description, per-channel descriptions (R, G, B)
   - 4.1. Color-Attribute Mappings (input: for initialization, brush tool, and image import)
   - 4.2. Attribute-Color Mappings (output: for visualization modes)

5. **Indicators** — quantitative monitoring variables, either standalone (read/write from graph) or linked to cell attributes (auto-computed aggregations: frequency, total)

6. **Update Rules** — a node graph defining what each cell computes per generation, compiled at edit time to one of three targets: WebAssembly (default), WebGPU, or JavaScript (debug / reference). All three compilers apply *value sinking* — value computations that are only consumed inside a specific switch case or if branch are emitted *inside* that branch rather than always at cell-top, so on type-dispatch models (Wireworld, etc.) the dominant cell type pays only for the work its branch actually needs.

---

## Features

### The Modeler
- **Properties Panel** — model metadata (Rule Author + GenesisCA Project Author), grid dimensions, boundary treatment (torus/constant), update mode (synchronous/asynchronous), tags, optional **Thumbnail** (PNG/JPEG/GIF/WebP up to 2 MB — shown on hover in the Models Library), optional End Conditions (max generations + indicator-based auto-pause rules)
- **Attributes Panel** — cell and model attributes with type-specific default value controls (bool, integer, float, tag, color, NeighborIndex); cell attributes gain an optional **Boundary Value** field when boundary is set to constant. NeighborIndex attributes show a clickable cell-grid editor anchored to a chosen *hint neighborhood* for picking the default slot. Selecting an item (a Cell/Model attribute or a Local Variable) opens its editor in a **second side panel** beside the list (the same master-detail layout is used by the Neighborhoods and Mappings panels) so you never scroll past a long list to reach the fields you're editing.
- **Neighborhoods Panel** — interactive grid editor with per-neighborhood margin, optional per-cell tags for named access, click the centre cell to include it (`[0,0]`) in the neighborhood, and a Duplicate button for quick variations
- **Mappings Panel** — Attribute-to-Color and Color-to-Attribute mapping definitions. Output (A→C) mappings can be **Standalone** (build the color graph by hand) or **Linked** — pick a cell attribute and GenesisCA auto-generates the color pass (bool → two-color; float/integer → a color scale spanning a user-set min/max, chosen from palette presets like Viridis/Magma/Rainbow or customized stop-by-stop with the same gradient editor as the Color Scale node; tag → one distinct color per option), all fully recolorable. A Linked mapping still works if you also drop its Output Mapping node into the graph: the auto pass runs first as a background and your graph overrides whichever cells it paints (special colors, glyphs, …). Lockstepped across the JS, WASM, and WebGPU compilers.
- **Indicators** — standalone (typed scalar, graph-writable) or linked (auto-aggregated from cell attributes: frequency, total), with per-generation or accumulated modes. Frequency indicators can be viewed as horizontal bars, multi-line time series, or stacked-area time series (viz button cycles the three; preference persists per indicator). In the Lines/Stack and spatial (chromatogram) views, **click a legend entry** to hide that series (click again to show it) — a per-session view toggle, separate from Track Categories. Linked indicators can also switch their **X-axis** from Generation to **Rows/Columns**, turning into a live **spatial histogram (chromatogram)** — one curve per series plotted against grid position, with selectable slice- or absolute-binning (reproduces the population-vs-position plots common in chemistry CA papers). Bool/Tag frequency indicators add a **Track Categories** checklist &mdash; chart only a chosen subset of category values so a dominant one doesn't flatten the rest on the shared Y-axis (e.g. a cell-type chromatogram can show just the two solutes and ignore the solvent). End Conditions accept per-category comparisons on frequency indicators (e.g. pause when count of `alive` cells &ge; 100).
- **Local Variables** — per-cell mutable scratch storage referenced by name across the graph (defined in the Attributes panel's Local Variables section; the editor opens in the shared detail panel). Lets you write rules as imperative pseudocode ("for each direction `d`, set `weights[d] = compute(d)`; then sample by weights") instead of unrolled dataflow. Scalar or fixed-length array; reset to an initial value at the start of every cell's computation. Nodes: Get Variable / Set Variable / Set Array Element, paired with For Each In Array's Index output. Runs on all three compile targets.
- **Graph Editor** — around 70 node types across 7 categories (event, flow, data, logic, aggregation, output, color — indicator readers/writers live within data/output), with RMB pan, scroll zoom, and snap-to-grid. The palette only shows nodes available for your model — async-only and Variegated-Cells nodes appear once you enable those features. Includes Switch (flow routing by conditions or value), For Each In Array (iterate any typed array, exposing the per-iteration Element **and** Index), an **Expression** node (type a math formula — `+ - * / % ^`, `sqrt abs floor ceil round min max pow mod` — instead of wiring up many Math nodes, ideal for equation-heavy models), **Value Switch** (a pure-value ternary — pick between two values without forking the flow; also relays arrays, so you can select between two neighbour sets and feed the result straight into Pick Random Neighbor), Get Random (random bool/int/float, or pick uniformly from an Options array), Proportion Map and Color Scale (multi-stop gradient with selectable curves: Linear, Smoothstep, Ease-In/Out Quadratic, Exponential, Logarithmic, plus one-click palette presets like Viridis/Magma/Rainbow), **Categorical Color** (map an integer index to a flat palette color — discrete, no blending), Interpolation, Aggregate / Group Reduce (multi-input math + median, weighted-random sampling), neighborhood tag-based access nodes, NeighborIndex bootstrap (Get All Neighbor Indexes), constructors, Flip, Pick Random Neighbor / Pick N Random Neighbors, generic Get Array Element / Array Length, and a **Stop Event** node that pauses the simulator with a user-defined message when its flow input fires.
- **Connection validation** — prevents incompatible connections (flow/value), cycles, and duplicate inputs; compatible ports highlight during drag
- **Inline Port Widgets** — input ports show small value editors (number/bool) when unconnected, eliminating the need for constant nodes in simple cases
- **Node Collapse/Expand** — double-click any node to collapse it; constants show their value; collapsed nodes temporarily expand when connecting edges
- **Palette** — right-side panel with a drag-and-drop list of every node type (grouped by category), default macros shipped with the app (from `public/macros/*.gcamacro`), and the current project's macros. Splits vertically into independently-scrolling **Nodes** and **Macros** sections with a draggable horizontal splitter; a **List / Visual** toggle switches between a compact text list and mini node-preview cards (split position and view mode persist across sessions)
- **Spacebar quick-add** — press `Space` over the canvas to open the Palette with its search focused: type to filter, `↑`/`↓` to move the always-present highlight (defaults to the best name match), `Enter` to add the highlighted node/macro exactly where the cursor was when `Space` was pressed; the panel collapses back automatically, `Esc` dismisses
- **Node Explorer** — searchable right-side panel (Ctrl+F to open, Esc to close) listing all placed nodes with click-to-focus
- **Incomplete-config warnings** — nodes with unset required parameters (e.g., an unselected attribute/neighborhood/mapping) show an amber warning badge in the header so you can spot them at a glance. Macro instances bubble up internal-node warnings (recursively through nested macros), so misconfigured internals are visible without opening the macro
- **Macro System** — encapsulate node groups into reusable subgraphs with MacroInput/MacroOutput boundary nodes. Reuse a macro as a **linked** (mirror) copy that shares one definition — editing any instance's internals updates all of them — or as an **independent** copy with its own definition. Drag from the Palette's Project Macros or right-click → **Duplicate → Duplicate Linked** to make a linked copy; **Duplicate → Duplicate Independent** (or copy/paste) makes an independent one. When 2+ instances share a definition, a small **count badge** (Blender-style) appears at the left of each Macro node's header; click it and choose **Make Independent Copy** to break the link for that instance
- **Undo/Redo** (partial) — Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) for node/edge operations, moves, paste, config changes
- **Copy/Paste/Duplicate** — Ctrl+C/V/X/D, context menu on single nodes and selections, paste at right-click location
- **Groups & Comments** — visual organization tools; comment background color is customizable and the resized size persists; Undo Group dissolves a group and selects all contained nodes. Drag a group's **header** to move it, drag its **body** to box-select inner nodes (Shift adds / Ctrl removes from the selection), click the body to select the group, and right-click-drag to pan; double-click the header to rename. A selected group **stays behind** its contained nodes (it no longer pops to the front), so you can keep clicking the nodes and links inside it
- **Reroute points** — bend wires and fan one output out to many places without long crossing links. **Press and hold** the left mouse button on a wire (~½ s) to drop a reroute that then follows your cursor; once placed it's an ordinary node — drag it to move it (and it moves with a multi-selection). A reroute always relays an **output** (one input, any number of outputs), and reroutes can be chained. They're purely cosmetic — a wire through a reroute compiles identically to a direct connection — and deleting one removes it and all its links
- **Interactive minimap** — the overview map (bottom-right) is pannable and zoomable, and a click jumps the viewport to that spot (keeping the current zoom)

### Variegated Cells (Directional Interactions) &mdash; opt-in
- **Per-cell orientation** — 0&ndash;3 = 0/90/180/270&deg; clockwise rotation, auto-allocated when the feature is on. Defaults to 0; set via the new `Set Orientation` node (typical pattern: an `Init Event` runs once on Reset, picks a random rotation per cell).
- **Face-label Palettes & Face Patterns** — define one or more named face-label **palettes** (independent label sets, e.g. analyte faces vs. stationary-phase faces). A **face pattern** is a named 8-slot layout (N/NE/E/SE/S/SW/W/NW; edges-only mode disables the four corners) that draws its labels from one palette. Assign a pattern to each tag option in the Attributes panel; the implicit `none` label covers unassigned slots and non-variegated neighbors.
- **`Lookup Table` model attribute** — a (possibly **rectangular**) matrix of float values with an independent **row key source** and **column key source**, each either a face-label palette (`['none', ...labels]`), a tag attribute (its options — e.g. empty/water/amphi), or **Single value (map)** — a one-element axis that collapses the table into a 1-D **map** keyed only by the other axis (no throwaway single-option tag attribute needed). A pure tag×tag table needs no faces, so it works even with Variegated Cells off. Edit in the Attributes panel; live-tune in the Simulator like any other model attribute.
- **New nodes** — `Get/Set Orientation`, `Get Facing Orientation`, `Get Neighbor Orientation By Index`, `Set Facing Orientation` / `Set Neighbor Orientation By Index` (async-only), `Get Facing Labels` / `Get All Facing Labels` (resolve the face labels touching at an encounter, accounting for both cells&apos; orientations and patterns), `Table Lookup` / `Table Map` (index a Lookup Table by a row and column index — works with or without Variegated Cells), and `Transfer Cell Attributes to Neighbor` (copy/move/swap cell attributes &amp; orientation between this cell and a neighbour; async-only). Fully supported on JS, WASM, and WebGPU — except the async-only nodes (the two orientation writers + `Transfer Cell Attributes to Neighbor`), which are unavailable on WebGPU (synchronous-only).
- **`Init Event` Node** — entry-point that runs once per cell on simulator Reset (after defaults, before the first color pass). Outputs `x`, `y`, `maxX`, `maxY` and triggers a DO flow chain. Useful for any model that wants procedural initial state, not just variegated ones.
- **Unlocks chemistry CA models** — water-aabb (H/LP face patterns + interaction matrix), amphiphile micelle formation, chiral chromatographic separation, structured solvent dynamics. References: Kier, Seybold &amp; Cheng (2005), Kier et al. (2000), DeSoi et al. (2013).
- **Ships as working samples** — the **Amphiphile** model implements the Kier book's move-into-empty micelle-formation rule end-to-end (Variegated Cells + Local Variables + chemistry primitives), with 9 interaction-table presets (the book's defaults plus the 8 Kier 1996 parameter sets). The **Chromatography** model (Kier, Cheng &amp; Karnes 2000) reproduces a packed-column separation of two solutes on a 43&times;200 async grid &mdash; a recirculating cylinder (a full torus: the gravity-driven mobile phase exits the bottom and flows back to the top, so it never just drains) where type&times;type **PB**/**J** Lookup Tables drive breaking/joining, a single gravity term pushes the mobile phase down the column, and a spatial **chromatogram** indicator plots solute population vs. column position (the paper's Figure 3). A detector line (a &ldquo;monitor&rdquo; cell flag on the bottom row) fires a **Stop Event** the moment the leading solute elutes &mdash; an event-driven analog of the paper&rsquo;s fixed-iteration snapshot. 17 presets span the paper's affinity, flow-rate, solvent-polarity and solvation studies.

### Asynchronous Mode
- **Update Mode** — choose Synchronous (classic CA) or Asynchronous (sequential updates with single buffer) in Model Properties
- **Read-after-write** — in async mode, re-reading a cell attribute after writing it earlier in the same rule (e.g. via a Sequence) observes the new value, matching the single-buffer imperative model (sync mode reads always see the previous generation)
- **Update Schemes** — Random Order, Random Independent, or Cyclic — balancing accuracy vs. performance
- **Async-only nodes** — Set Neighborhood Attribute, Set Neighbor Attr By Index, and Mark Cell Updated for number-conserving movement patterns. Mark Cell Updated flags a neighbour as already-updated so the scheduler skips it for the rest of the generation (prevents a particle from chain-moving across the grid in one step when it follows the random update order). Get Neighbor Attr By Index is read-only and works in both modes.
- **NeighborIndex type** — first-class typed handle that carries a packed `(dr, dc)` offset to a neighbor cell. Position-only and neighborhood-agnostic, so filter/pick/iterate/set chains compose without ever asking "from which neighborhood?". Companion nodes: Get All Neighbor Indexes, Pick Random Neighbor, Pick N Random Neighbors, Neighbor Index (from Offset / from Tag), Flip Neighbor Index. Wiring a non-NI integer source into an NI port shows an amber warning badge on the target node.
- **For Each In Array** — flow node that iterates a typed array and exposes the per-iteration **Element** and its 0-based **Index** via output ports. Useful for "iterate matching neighbors" patterns; body nodes can consume the element directly, and the index lets the body address parallel arrays by slot (e.g. writing `weights[index]` into a Local Variable).

### The Simulator
- **Transport bar** — Play/Pause/Step/Reset with FPS and Gens/Frame sliders, keyboard shortcuts (Space=step, Enter=play/pause, Esc=reset)
- **Save Project dialog** — checkboxes to include simulator controls (speed, brush, mapping, model-attribute values) and/or the full board state; choices persist across sessions
- **Save / Load State** — save the full simulation snapshot (`.gcastate`) for experiment repeatability; load to restore a previous state. State is also embedded in `.gcaproj` for project-level persistence.
- **Model Presets** — embed named snapshots of model-attribute values (and optionally the cell grid) in the project, listed in the left panel above Model Attributes. One-click switching between behavioral variants — ideal for generic models like MNCA where the same rules produce wildly different emergent patterns per parameter set. Include/exclude from `.gcaproj` via the Save Project dialog.
- **Canvas controls** — LMB=brush, RMB=pan, MMB=toggle autoscroll (anchor + speed-by-distance pan; Esc to exit), scroll=zoom, Ctrl+LMB drag=resize brush, Ctrl+wheel=cycle input mappings, Shift+RMB=open in-page color picker at the cursor, Shift+LMB=open Inspect Cell popup (live attribute readout + RGB; draggable and stackable for comparing cells; hover to highlight the linked cell), Shift+LMB drag=sweep inspect (a single transient popup follows the cursor cell and is discarded on release
- **Brush tool** — configurable color (with live R/G/B channel inputs beside the picker), width/height, input mapping; visual brush cursor; Ctrl+drag interactive resize
- **Manual Brush** — always-available "Manual" tab in the brush mapping strip lets you paint cell attributes directly without authoring a Color→Attribute mapping. One row per cell attribute with a "Set" checkbox and a type-appropriate value widget (bool dropdown / number input / tag dropdown); unchecked attributes are skipped at paint time. Sub-attributes follow per-cell skip semantics — a sub-attribute write only lands on cells whose effective parent value (brush value if also Set, else the cell's current value) matches `parentValues`. Configuration persists per-model.
- **Region clipboard** — Ctrl+C/V/X on the simulator copy/paste/cut all cell attributes within the brush rectangle; paste anchors to the brush's top-left corner
- **Viewer tabs** — horizontal bar at the top to switch between Attribute-to-Color visualization modes; hovering a viewer tab (or a Color→Attribute brush tab) shows the mapping's description as a tooltip
- **Cell inspector** — Shift+LMB opens a live attribute readout; NeighborIndex attributes decode to their `(dr, dc)` offset (not the raw packed integer), and variegated models show the cell's orientation as an extra row
- **Glyph overlay** — drop a `Set Cell Glyph` node into any Output Mapping to paint a Unicode character on top of each cell (any character, in any RGB colour). Per-cell glyph + colour are computed by the same node graph as the cell colour, so patterns like `GetOrientation → Switch → SetCellGlyph(↑→↓←)` show per-cell facing direction at a glance. Cached pre-rasterised tiles keep it fast; glyphs hide automatically when cells are too small to read.
- **Infinite-tile mode** — the ∞ button (torus-boundary models only) tiles the grid across the viewport so you can pan endlessly across the wrap seams
- **Live model attribute controls** — change global parameters without recompiling
- **Grid dimension overrides** — experiment with different sizes
- **PNG screenshot export** — captures the display view with current zoom/pan (nearest-neighbor upscale for crisp pixels)
- **Recording** — record simulation frames and export as **WebM** (default; native grid resolution, smaller files, no 256-colour limit; needs WebCodecs) or animated **GIF** (256 colours, auto-downscaled to 512&nbsp;px max)
- **Open Image** — load PNG/BMP/JPG as starting point via the brush panel

### Help & Library
- **In-app Help tab** — feature reference with sidebar navigation
- **Models Library** — pre-made models loaded from the repository, no manual index required; cards are sorted alphabetically by display name and show a floating thumbnail preview on hover (animated GIFs play natively)
- **Library-first** — every tab open / reload lands on the Library tab so you can pick a starting model or fork one into your own
- **Unsaved changes warning** — the browser prompts before closing the tab if your model has unsaved changes (explicit save only — no auto-restore on reload)

---

## Documentation

- [Node Reference](docs/NODES_REFERENCE.md) — full catalogue of all ~70 node types, port schemas, and compile-time semantics, with Mermaid diagrams of common patterns.
- [CA Literature Review](docs/CA_LITERATURE_REVIEW.md) — a survey of ~70 canonical cellular-automata models across physics, chemistry, biology, ecology, sociology, transport, earth sciences, CS theory and cryptography, with a shortlist driving GenesisCA's feature roadmap.

---

## Getting Started (if you want to contribute, fork or run the code locally)

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ (22 LTS recommended)
- npm 9+ (comes with Node.js)

### Setup

```bash
git clone https://github.com/rff255/GenesisCA.git
cd GenesisCA
npm install
npm run dev
```

The app opens at **http://localhost:5173**.

### Available Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview the production build locally |

### Tech Stack

- **TypeScript + React** — UI framework
- **Vite** — build tool and dev server
- **React Flow** — node-based graph editor
- **Canvas2D** — grid rendering
- **Web Workers** — off-thread simulation engine
- **CSS Modules** — scoped component styling

---

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

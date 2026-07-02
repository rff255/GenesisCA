# GenesisCA <sup>v1.24.0</sup>

An IDE for modeling and simulating Cellular Automata, built as a self-contained browser application.

**[Launch GenesisCA](https://genesisca.online)** — runs entirely in your browser, no installation required.

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
Detailed in-app help tab with a comprehensive tutorial and reference material regarding features, usage, shortcuts and such. Press **?** anywhere (or the navbar keyboard-shortcuts button) for a quick on-screen shortcuts cheat sheet, and **F** (or the **⛶** button on the canvas) to maximize the canvas. A navbar **Theme** switcher offers two dark themes (**Blender** and **Nocturne**):
![Library](docs/Gifs/help.gif)

### **Install & Offline**
GenesisCA is an installable [Progressive Web App](https://web.dev/explore/progressive-web-apps). Open it in Chrome or Edge and use the navbar **⤓ Install** button (or the browser's own install affordance) to add it as a standalone desktop app — its own window and icon (no tabs or address bar) — that **runs fully offline**: the app, the Models Library, previews, and your work are served from a local cache. A standalone portable **`GenesisCA.exe`** — a [Tauri](https://tauri.app) shell wrapping the same build — is published to the [Releases](https://github.com/rff255/GenesisCA/releases/latest) page: download and run it directly, no install (it runs from anywhere, e.g. a USB stick).

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

2. **Attributes** — each has a name, type (binary, integer, decimal, tag, color, NeighborIndex), description, and a default value
   - 2.1. Cell Attributes (per-cell state) — including NeighborIndex for cells that point at one of their neighbors (movement direction, leader-follower, etc.). Cell attributes can also be marked as **sub-attributes** — only well-defined when a parent (Tag or Binary) cell attribute is in a chosen value set, e.g. *charge* defined only on Wire (wireworld model). The compiler auto-injects parent-check guards at every read site so rules express "count head-charges around me" directly, with no manual filter-by-type chains
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
- **Info Panel** — model presentation metadata: Name, Rule Author, GenesisCA Project Author, a short **Summary** (the blurb shown on the model's Models Library card) and a longer free-form **Rule Description** (elaborate on how the rule works — not shown on cards), tags, and an optional **Thumbnail** (PNG/JPEG/GIF/WebP up to 2 MB — shown on hover in the Models Library)
- **Properties Panel** — grid dimensions, a **Dimension** radio (2D / 3D — 3D adds a Grid Depth field and makes the lattice a `W×H×D` volume), boundary treatment (torus/constant), update mode (synchronous/asynchronous), optional End Conditions (max generations + indicator-based auto-pause rules), and the Indicators list. A **Topology** group (Grid Cells / Bond-Graph Agents — see *Bond-Graph Agents* below) sits in Execution, with a *Bond-Graph Agents* config block when Agents is enabled.
- **Attributes Panel** — cell and model attributes with type-specific default value controls (binary, integer, decimal, tag, color, NeighborIndex); cell attributes gain an optional **Boundary Value** field when boundary is set to constant. NeighborIndex attributes show a clickable cell-grid editor anchored to a chosen *hint neighborhood* for picking the default slot. Selecting an item (a Cell/Model attribute or a Local Variable) opens its editor in a **second side panel** beside the list (the same master-detail layout is used by the Neighborhoods and Mappings panels) so you never scroll past a long list to reach the fields you're editing.
- **Neighborhoods Panel** — interactive grid editor with per-neighborhood margin, optional per-cell tags for named access, click the centre cell to include it (`[0,0]`) in the neighborhood, and a Duplicate button for quick variations. **Drawing tools** (Point / Circle / Ring / Line) make MNCA-scale neighborhoods quick: Circle edits a filled disc from a center + edge click, Ring the band between an inner and outer radius (3 clicks), Line every cell between two endpoints. A **Mark / Unmark / Toggle** mode picks what an edit does to covered cells, and independent **symmetry toggles** (horizontal / vertical / main-diagonal / anti-diagonal — any three = full 8-fold) mirror every edit so you only draw one octant. The live hover preview is color-coded by outcome (will-activate / will-deactivate / unchanged), readable over both filled and empty cells
- **Mappings Panel** — Attribute-to-Color and Color-to-Attribute mapping definitions. Output (A→C) mappings can be **Standalone** (build the color graph by hand) or **Linked** — pick a cell attribute and GenesisCA auto-generates the color pass (binary → two-color; decimal/integer → a color scale spanning a user-set min/max, chosen from palette presets like Viridis/Magma/Rainbow or customized stop-by-stop with the same gradient editor as the Color Scale node; tag → one distinct color per option), all fully recolorable. A Linked mapping still works if you also drop its Output Mapping node into the graph: the auto pass runs first as a background and your graph overrides whichever cells it paints (special colors, glyphs, …). Lockstepped across the JS, WASM, and WebGPU compilers. The **Set Cell Looks** node can also target **Current Simulator Selected** instead of a fixed mapping — writing to whichever viewer is active — so one color pass can be reused across several viewers that differ only in other respects.
- **Indicators** — defined in the Properties panel; click one in the list to edit it in a **second side panel** beside the list (the same master-detail layout as Attributes/Neighborhoods/Mappings). Standalone (typed scalar, graph-writable) or linked (auto-aggregated from cell attributes: frequency, total), with per-generation or accumulated modes. Frequency indicators can be viewed as horizontal bars, multi-line time series, or stacked-area time series (viz button cycles the three; preference persists per indicator). In the Lines/Stack and spatial (chromatogram) views, **click a legend entry** to hide that series (click again to show it) — a per-session view toggle, separate from Track Categories. Each chart has a **gear popover** for fixed Y min/max (blank = dynamic), Y tick count, and per-series colors — set model-level defaults in the Modeler (they travel in the `.gcaproj`), tweak per-user overrides in the Simulator (persisted locally and saved with the project when "Simulator controls" is ticked). Linked indicators can also switch their **X-axis** from Generation to **Rows/Columns**, turning into a live **spatial histogram (chromatogram)** — one curve per series plotted against grid position, with selectable slice- or absolute-binning (reproduces the population-vs-position plots common in chemistry CA papers). Binary/Tag frequency indicators add a **Track Categories** checklist &mdash; chart only a chosen subset of category values so a dominant one doesn't flatten the rest on the shared Y-axis (e.g. a cell-type chromatogram can show just the two solutes and ignore the solvent); each series keeps its own stable color as you toggle which categories are tracked. End Conditions accept per-category comparisons on frequency indicators (e.g. pause when count of `alive` cells &ge; 100).
- **Local Variables** — per-cell mutable scratch storage referenced by name across the graph (defined in the Attributes panel's Local Variables section; the editor opens in the shared detail panel). Lets you write rules as imperative pseudocode ("for each direction `d`, set `weights[d] = compute(d)`; then sample by weights") instead of unrolled dataflow. Scalar or fixed-length array; reset to an initial value at the start of every cell's computation. Nodes: Get Variable / Set Variable / Set Array Element, paired with For Each In Array's Index output. Runs on all three compile targets.
- **Graph Editor** — over 100 node types across 7 categories (event, flow, data, logic, aggregation, output, color — indicator readers/writers live within data/output), with RMB pan, scroll zoom, and snap-to-grid. The palette only shows nodes available for your model — async-only, Variegated-Cells, and Bond-Graph-Agent nodes appear once you enable those features. Includes Switch (flow routing by conditions or value), For Each In Array (iterate any typed array, exposing the per-iteration Element **and** Index), an **Expression** node (type a math formula — `+ - * / % ^`, `sqrt abs floor ceil round min max pow mod exp log sin cos tan tanh` — instead of wiring up many Math nodes, ideal for equation-heavy models), **Value Switch** (a pure-value ternary — pick between two values without forking the flow; also relays arrays, so you can select between two neighbour sets and feed the result straight into Pick Random Neighbor), Get Random (random binary/integer/decimal, or pick uniformly from an Options array), Proportion Map and Color Scale (multi-stop gradient with selectable curves: Linear, Smoothstep, Ease-In/Out Quadratic, Exponential, Logarithmic, plus one-click palette presets like Viridis/Magma/Rainbow), **Categorical Color** (map an integer index to a flat palette color — discrete, no blending), Interpolation, Aggregate / Group Reduce (multi-input math + median, weighted-random sampling), neighborhood tag-based access nodes, NeighborIndex bootstrap (Get All Neighbor Indexes), constructors, Flip, Pick Random Neighbor / Pick N Random Neighbors, generic Get Array Element / Array Length, and a **Stop Event** node that pauses the simulator with a user-defined message when its flow input fires.
- **Flow chaining (NEXT / DONE)** — every action node has a pass-through **NEXT** flow output and every flow-control node a **DONE** (completed) output, so executions chain UE-Blueprints-style (`Set A → Set B → Set C`) instead of fanning wires out of one DO port or inserting Sequence nodes. Zero runtime cost — chains compile to exactly the same code as the equivalent fan-out, on all three targets
- **Connection validation** — prevents incompatible connections (flow/value), cycles, and duplicate inputs; compatible ports highlight during drag
- **Inline Port Widgets** — input ports show small value editors (number/binary) when unconnected, eliminating the need for constant nodes in simple cases
- **Node Collapse/Expand** — double-click any node to collapse it; constants show their value; collapsed nodes temporarily expand when connecting edges. A collapsed node still **fans its connected ports out** (at a tight spacing) so you can tell which wire goes where without expanding it
- **Palette** — right-side panel with a drag-and-drop list of every node type (grouped by category), default macros shipped with the app (from `public/macros/*.gcamacro`), and the current project's macros. Splits vertically into independently-scrolling **Nodes** and **Macros** sections with a draggable horizontal splitter; a **List / Visual** toggle switches between a compact text list and mini node-preview cards (split position and view mode persist across sessions)
- **Quick-add node menu** — press `Space` over the canvas (or right-click blank canvas) to open a focused add-node menu right at the cursor: the usual actions (Paste / Add Comment / Add Group / Import Macro…) on top, then a search field and a category-grouped node list. Type to filter, `↑`/`↓` to move the always-present highlight (defaults to the best name match), `Enter` to add the highlighted node where the cursor was, `Esc` to dismiss. It's the same searchable list you get when you drag a wire onto empty canvas
- **Searchable connection-drop menu** — drag a wire off any port and release on empty canvas to get a searchable list of compatible nodes: type keywords to filter, `↑`/`↓` to move the highlight, `Enter` to add the node at the release point and auto-wire it (same keyboard flow as quick-add). Dragging from an output also offers Reroute
- **Node Explorer** — searchable right-side panel (Ctrl+F to open, Esc to close) listing all placed nodes with click-to-focus
- **Incomplete-config warnings** — nodes with unset required parameters (e.g., an unselected attribute/neighborhood/mapping) show an amber warning badge in the header so you can spot them at a glance. Macro instances bubble up internal-node warnings (recursively through nested macros), so misconfigured internals are visible without opening the macro
- **Macro System** — encapsulate node groups into reusable subgraphs with MacroInput/MacroOutput boundary nodes. Reuse a macro as a **linked** (mirror) copy that shares one definition — editing any instance's internals updates all of them — or as an **independent** copy with its own definition. Drag from the Palette's Project Macros or right-click → **Duplicate → Duplicate Linked** to make a linked copy; **Duplicate → Duplicate Independent** (or copy/paste) makes an independent one. When 2+ instances share a definition, a small **count badge** (Blender-style) appears at the left of each Macro node's header; click it and choose **Make Independent Copy** to break the link for that instance
- **Align while dragging** — hold **Ctrl** (or Cmd) while moving any node, comment, or group and it snaps so its edges/center line up with nearby nodes, showing dashed guide lines (PowerPoint-style). Works for single nodes, multi-selections (the selection's outer box aligns), and groups; overrides snap-to-grid while held
- **Undo/Redo** (partial) — Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) for node/edge operations, moves, paste, config changes
- **Copy/Paste/Duplicate** — Ctrl+C/V/X/D, context menu on single nodes and selections, paste at right-click location
- **Groups & Comments** — visual organization tools; comment background color is customizable and the resized size persists; Undo Group dissolves a group and selects all contained nodes. Drag a group's **header** to move it, drag its **body** to box-select inner nodes (Shift adds / Ctrl removes from the selection), click the body to select the group, and right-click-drag to pan; double-click the header to rename. A selected group **stays behind** its contained nodes (it no longer pops to the front), so you can keep clicking the nodes and links inside it
- **Reroute points** — bend wires and fan one output out to many places without long crossing links. **Press and hold** the left mouse button on a wire (~½ s) to drop a reroute that then follows your cursor; once placed it's an ordinary node — drag it to move it (and it moves with a multi-selection). A reroute always relays an **output** (one input, any number of outputs), and reroutes can be chained. They're purely cosmetic — a wire through a reroute compiles identically to a direct connection — and deleting one removes it and all its links
- **Interactive minimap** — the overview map (bottom-right) is pannable and zoomable, and a click jumps the viewport to that spot (keeping the current zoom)

### Variegated Cells (Directional Interactions) &mdash; opt-in
- **Per-cell orientation** — 0&ndash;3 = 0/90/180/270&deg; clockwise rotation, auto-allocated when the feature is on. Defaults to 0; set via the new `Set Orientation` node (typical pattern: an `Init Event` runs once on Reset, picks a random rotation per cell).
- **Face-label Palettes & Face Patterns** — define one or more named face-label **palettes** (independent label sets, e.g. analyte faces vs. stationary-phase faces). A **face pattern** is a named 8-slot layout (N/NE/E/SE/S/SW/W/NW; edges-only mode disables the four corners) that draws its labels from one palette. Assign a pattern to each tag option in the Attributes panel; the implicit `none` label covers unassigned slots and non-variegated neighbors.
- **`Lookup Table` model attribute** — a (possibly **rectangular**) matrix of decimal values with an independent **row key source** and **column key source**, each either a face-label palette (`['none', ...labels]`), a tag attribute (its options — e.g. empty/water/amphi), or **Single value (map)** — a one-element axis that collapses the table into a 1-D **map** keyed only by the other axis (no throwaway single-option tag attribute needed). A pure tag×tag table needs no faces, so it works even with Variegated Cells off. Edit in the Attributes panel; live-tune in the Simulator like any other model attribute.
- **New nodes** — `Get/Set Orientation`, `Get Facing Orientation`, `Get Neighbor Orientation By Index`, `Set Facing Orientation` / `Set Neighbor Orientation By Index` (async-only), `Get Facing Labels` / `Get All Facing Labels` (resolve the face labels touching at an encounter, accounting for both cells&apos; orientations and patterns), `Table Lookup` / `Table Map` (index a Lookup Table by a row and column index — works with or without Variegated Cells), and `Transfer Cell Attributes to Neighbor` (copy/move/swap cell attributes &amp; orientation between this cell and a neighbour; async-only). Fully supported on JS, WASM, and WebGPU — except the async-only nodes (the two orientation writers + `Transfer Cell Attributes to Neighbor`), which are unavailable on WebGPU (synchronous-only).
- **`Init Event` Node** — entry-point that runs once per cell on simulator Reset (after defaults, before the first color pass). Outputs `x`, `y`, `maxX`, `maxY` and triggers a DO flow chain. Useful for any model that wants procedural initial state, not just variegated ones.
- **Unlocks chemistry CA models** — water-aabb (H/LP face patterns + interaction matrix), amphiphile micelle formation, chiral chromatographic separation, structured solvent dynamics. References: Kier, Seybold &amp; Cheng (2005), Kier et al. (2000), DeSoi et al. (2013).
- **Ships as working samples** — the **Amphiphile** model implements the Kier book's move-into-empty micelle-formation rule end-to-end (Variegated Cells + Local Variables + chemistry primitives), with 9 interaction-table presets (the book's defaults plus the 8 Kier 1996 parameter sets). The **Chromatography** model (Kier, Cheng &amp; Karnes 2000) reproduces a packed-column separation of two solutes on a 43&times;200 async grid &mdash; a recirculating cylinder (a full torus: the gravity-driven mobile phase exits the bottom and flows back to the top, so it never just drains) where type&times;type **PB**/**J** Lookup Tables drive breaking/joining, a single gravity term pushes the mobile phase down the column, and a spatial **chromatogram** indicator plots solute population vs. column position (the paper's Figure 3). A detector line (a &ldquo;monitor&rdquo; cell flag on the bottom row) fires a **Stop Event** the moment the leading solute elutes &mdash; an event-driven analog of the paper&rsquo;s fixed-iteration snapshot. 17 presets span the paper's affinity, flow-rate, solvent-polarity and solvation studies.

### 3D Grid CA &mdash; opt-in
- **Volume lattice** — flip **Dimension** to **3D** in Properties to make the grid a `W×H×D` volume. The engine is dimension-agnostic (`total = W*H*D`, a 3-tuple neighbour-offset table, a per-cell layer decode) and runs on **all three compile targets** (JS / WASM / WebGPU) — a 2D model compiles byte-identically. Ships a **Life3D** sample (Carter Bays' 5766 rule on a 24³ torus).
- **3D neighbourhoods** — the Neighborhoods panel swaps the flat grid for a **parametric** builder (Moore / von Neumann / Ball / Range-N / Shell / Ring / Disk, with an L∞/L1/L2 metric) plus a **slice-stack editor** (step through Z layers, toggle cells, three axis-plane mirrors, per-cell tags) and a live orbiting **3D preview**.
- **3D NeighborIndex offsets** — the whole NeighborIndex node family works in 3D: the packed codec is dimension-aware (2D `(dr, dc)`; 3D `(dr, dc, dl)`), and *Neighbor Index (from Offset)* / *Break Down Neighbor Index* gain a `dl` (layer) port in 3D.
- **WebGL2 voxel renderer** — the simulator renders 3D models as instanced cubes (only live, non-transparent cells are drawn): **orbit** the camera (Blender-style, Z-up: middle-drag / Alt+drag / right-drag, wheel zoom, Shift to pan), click the **corner gizmo**'s axis tips to snap to a view (the gizmo is depth-sorted and labelled **C / R / D** for column / row / depth; clicking **D** looks straight down so the volume reads **exactly like the 2D CA** — column right, row down, depth into the screen), toggle axes / grid / bounds / gizmo / auto-orbit (the **axes** start at the `(0,0,0)` origin corner and grow toward +column / +row / +depth), and pull a **clip/slice plane** (X/Y/Z or the camera view) to see inside. **Painting** uses an **interaction plane** (shown with bounds + a grid, and a cube cursor on the hovered cell): a left-drag stamps the current brush **shape + size** (Rect / Circle / Ring / Line) flat in the slice, just like the 2D brush (with drag interpolation + torus wrap), or tick **Volumetric Brush** to paint a 3D solid (sphere / shell / box — with its own Depth field — / tube) through the depth; **Shift-click** inspects a cell (highlighted in the volume while you hover its popup), **Shift-drag** sweeps a single transient inspector across cells, **Ctrl/Cmd-drag** resizes the brush, and **Ctrl/Cmd-scroll** cycles the input mapping. **Authorable alpha** (a new `A` input on Set Cell Looks, default opaque) lets dead cells go transparent so the structure shows through; an opt-in alpha-blend toggle composites translucent cells.
- **Spatial chromatograms in Z** — linked indicators gain a **Layers** spatial X-axis (the Z sibling of Rows/Columns). Save/load round-trips the full volume through `.gcaproj`/`.gcastate`.

### Bond-Graph Agents (Floating Cells) &mdash; opt-in
- **Off-lattice agents** — a second, co-resident engine for "cells" that **float in continuous space** instead of sitting on a fixed grid. Tick **Bond-Graph Agents** in Properties &rarr; Execution &rarr; Topology (a model can run *both* the grid CA and the agents at once). By default agents move only by the forces **your rule graph** applies (Apply Force / Set Velocity) &mdash; ideal for flocking or chemotaxis; tick **Use bonding physics** to switch on the built-in center-based engine (soft-sphere repulsion, growth, bond springs, auto-bond) for morphogenesis. Either way they run their own per-agent rule graph &mdash; the off-lattice analog of the grid's per-cell step. The engine is an overdamped force integrator with a uniform spatial hash (O(N), thousands of agents at interactive rates); the hash anchors to the agents' bounding box, so the cost tracks the **number of agents and their spread, not the grid size** — resizing the world up doesn't slow the agents, and an **agents-only** model (untick Grid Cells) doesn't pay for a lattice at all.
- **Agents are first-class entities with their own state** — they carry their **own attributes and local variables**, kept in a separate id-space from the grid's cell attributes (the Attributes panel lists agent attributes when you're on the Agents tab). A grid cell attribute can opt into agent access (read or read/write) to become a shared **field**; cells can never read agent state.
- **Bonds & tension-axis division** — agents can be joined by **bonds** (springs with a rest length and stiffness, formed by a *Form Bond* node or auto-bonded by distance with hysteresis). A grown agent **divides** along its **tension axis** &mdash; the net-stretch direction of its bonds, so a glued cluster elongates and cleaves along its *mechanical* axis &mdash; with each partner bond **inherited by geometry** (handed to whichever daughter ends up nearer) and a fresh daughter&ndash;daughter bond keeping the tissue connected. That's morphogenesis: 12 cells grow into a connected sheet of ~1500.
- **The cell CA *is* the morphogen field (closed feedback)** — every grid **cell attribute doubles as a diffusible field** the agents both sense and shape. Agents **secrete** into it (*Secrete To Field* / *Affect Cells Under*), the grid CA **diffuses** it with an ordinary rule, and agents **sense** the result at their continuous position (*Sample Field* / *Field Gradient* / *Read Cells Under*) and respond &mdash; closing an agent&harr;grid loop that unlocks stigmergy, chemotaxis, and hypoxia-driven branching without any new field machinery.
- **Agents sense each other &amp; the graph authors the forces** — **Get Nearby Agents** returns the flock-mates within a radius (the agent analog of *Get Neighbors*); read each with **Get Agent Position / Offset / Attribute / Radius / Get Velocity**, then steer with **Apply Force** so the rule graph *authors the physics* (separation/alignment/cohesion, chemotaxis up a gradient, propulsion) on top of (or instead of) the engine soft-sphere. **Get Agent Offset** &mdash; or **Get Agent Position** in its *relative* mode (whose *Reference* defaults to self, or can be any agent) &mdash; gives the *torus-shortest* displacement to a neighbour, so flocking stays correct across a wrapped boundary (rather than hand-subtracting two raw positions); Get Agent Position's *absolute* mode still returns the raw position. A **momentum** setting adds flocking inertia, **Get Curvature** measures local membrane curvature, and **Set Agent Attribute** signals a neighbour.
- **Two-graph editor** — enabling Agents adds a second rule graph (the **Agents** graph) alongside the **Cells** graph, switched by a **Cells / Agents** tab strip above the canvas behind the same editor. The palette swaps per tab: agent nodes appear only on Agents, grid/neighbourhood nodes only on Cells, and universal nodes (math, conditionals, Get/Set Attribute over the shared attributes, Set Cell Looks) in both. Agent nodes: **Behaviour Step** + **Division Event** roots; the reads **Get Self Position / Radius / Bond Degree / Neighbour Density / Velocity / Curvature** and the neighbour reads **Get Nearby Agents / Get Bonded Agents / Agent Position / Agent Offset / Agent Attribute / Agent Radius**; the set/array ops **Filter Agents / Join Agents / Pick Random Agent / Pick N Random Agents / Get Agents Attribute** (gather one attribute over an id array for Aggregate / Group Counting) **/ Set Agents Attribute**; the actions **Set Target Radius / Apply Force / Set Velocity / Set Agent Attribute / Form Bond / Break Bond / For Each Bond / Divide Agent / Kill Agent**; and the field bridge **Sample Field / Field Gradient / Read Cells Under / Affect Cells Under / Secrete To Field**.
- **Graph-authored spawning** — an **Agent Init Event** root runs once per Reset; loop inside it and spawn the initial population with **Create Agent** (allocate a staged agent → a handle) &rarr; **Set Agent Position / Radius** (or Set Agent Attribute) &rarr; **Add Agent To World** (commit it). So a whole grid, blob, or scattered swarm is laid out by the rule graph rather than a fixed seeder. Agents carry **only your own agent attributes** — there's no built-in "type" field.
- **Agent Output Mappings (authorable views)** — agents get their **own Attribute→Color views**, the off-lattice analog of the grid's, and like the grid's they can be **Linked** (pick an **agent attribute → colour**, a colour scale or per-tag palette) or **Standalone** — a **graph** you build on the Agents tab (an **Agent Output Mapping (A→C)** event node → whatever exhibition you like), running *after* the Behaviour/Division step so it reads the agent's live state. When both the grid and the agents define views, the simulator's viewer bar becomes a **two-layer selection** (a *Cells* row + an *Agents* row).
- **Agent sprites** — draw an agent as a **static image or an animated GIF** instead of a circle. Import sprites in the Mappings panel; a **Set Agent Sprite** node controls the exhibition from your rule graph, with independently-tickable **change sprite / set frame / set speed** options (speed in frames per simulation step — **negative reverses**, 0 holds). Playback is **driven by the agent's logic** (e.g. *while moving, play the walk cycle; while idle, hold*), not a manual transport.
- **Self-attribute nodes** — on the Agents graph the universal Get / Set / Update Attribute nodes read as **Get / Set / Update Self Attribute** (they read/write the current agent's own state), pairing naturally with **Get/Set Agent Attribute** (another agent by id). **Get Self Handle** exposes the agent's own id so a neighbour can reference back to you (or you can compare a nearby-agent id against self). **Pure-force models** are first-class too: set **Max Bonds / Agent to 0** for agents that interact only by graph-authored forces (e.g. charged particles repelling/attracting via a field) with no bond store at all. In a **3D** model the Create Agent / Set Agent Position / Get Agent Position / Apply Force / Set Velocity nodes expose a **Z** axis.
- **Vector & Color value types** — bundle X / Y / Z onto one **vector** wire (or R / G / B / A onto one **color** wire) with **Make Vector / Break Vector** and **Make Color / Break Color** (the Unreal/Blender Make-Break pattern), and do whole-vector math with **Vector Op** (add / subtract / scale / dot / cross / length / normalize / distance / negate / lerp) — so you operate on a coordinate as a unit instead of touching each component. Apply Force has an optional **Vector input** mode that takes a force vector directly. (Composite-type nodes are editor sugar — a shared pre-compile pass lowers them to scalar math, so they run **natively on all three compile targets**, grid and agents.)
- **Config panel** — the **Bond-Graph Agents** block (shown when Agents is on) sets agent/bond ceilings, seed count + pattern (compact blob or scattered), default radius, and the always-on **Motion** knobs (momentum, max speed, neighbour query radius, time step &mdash; auto-clamped for stability, drag). A master **Use bonding physics** toggle (**off by default**) reveals the engine's **Forces** (soft-sphere repulsion, adhesion, interaction range, growth rate) and **Bonds** (auto-bond, stiffness, form/break distances) &mdash; so enabling Agents no longer silently switches those on. Capacity ceilings are over-allocated and **reject on overflow, never wrap**.
- **Ships as eight working samples** — **Morphogenesis — Growing Tissue** (12 → ~1500 cells dividing along the tension axis); **Morphogenesis — Differential Tissue** (asymmetric division + a maturity gradient + contact inhibition = cell *specialization*, a self-limiting tissue); **Morphogenesis — 3D Tissue** (the same engine growing a connected tissue in a 3D volume — the 3D bullet below in action); **Boids — Flocking** (separation/alignment/cohesion via Get Nearby Agents + Apply Force); **Chemotaxis — Aggregation** (slime-mould: secrete a chemical, the grid CA diffuses it, agents climb the gradient and aggregate); **Game of Life on Agents** (Conway's totalistic rule running on a grid of agents spawned by the Agent Init Event &mdash; a genericity proof that a classic lattice CA is just an agent rule); **Ant Necrophoresis** (stigmergy: ants random-walk, sense local corpse density via the field bridge, and pick up isolated bodies / drop them on clusters, so corpse piles self-organize); and the **Agent WASM Drift Test** (a minimal deterministic parity vehicle for the WASM agent target).
- **3D agents** — agents simulate and render in a **3D volume** too (not just 2D): they're pushed by 3D forces, **divide along their 3D tension axis**, and draw as shaded **sphere impostors with bond lines** in the voxel viewport, with a 3D agent brush + inspector. In 3D the agents always draw **on top of** the grid voxels (the grid is the background they navigate), the **clip interval** (two From/To handles slicing a visible slab) cuts voxels, spheres **and bonds**, and the docked **Agents → Layers** panel lets you independently **Show** and **Simulate** the grid and the agents (freeze either layer, or hide a layer to declutter). A 2D agent model keeps the byte-identical Canvas2D overlay.
- **Independent grid/agent execution model** — the agent engine's **compile target** AND **update synchronicity** are set in Properties → Bond-Graph Agents, *independently of the grid's*, so a **synchronous grid rule can run with asynchronous agents, and vice versa**. **Compile Target:** **JavaScript** (full coverage), **WebAssembly** (FULL coverage with **JS bit-parity** — the whole agent-node catalogue runs on WASM, exact to the last bit; typically **2-5× faster than JS** for heavy per-agent rules), or **WebGPU** (the whole agent-node catalogue runs on the GPU — Boids 2D/3D, chemotaxis via the field bridge in 2D **and 3D** (trilinear), growing/dividing tissue, Game of Life on agents; a glyph appearance is a harmless no-op (agents draw as dots on every target), and only a couple of order-dependent ops fall back to JS — statistical parity as on the grid). **Update Mode:** **Asynchronous** (a *Set Agent Attribute* to a neighbour is immediately visible this step) or **Synchronous** (every agent reads the previous step; writes swap in at the step's end — the snapshot/parallel semantics the GPU path needs). The **grid** independently runs on JS / WASM / **WebGPU**: a WASM grid shares memory with the agents directly, and a **WebGPU grid** (e.g. GPU chemical diffusion) feeds the agents via a per-step field-readback bridge. The grid/lattice path is unchanged on all three targets.

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
- **Model Presets** — embed named snapshots of model-attribute values (and optionally the cell grid) in the project, listed in the left panel above Model Attributes. One-click switching between behavioral variants — ideal for generic models like MNCA where the same rules produce wildly different emergent patterns per parameter set. Loading a parameter preset applies it live **without pausing** a running simulation (only a preset that changes grid dimensions or boundary treatment pauses, since that restarts the engine). Include/exclude from `.gcaproj` via the Save Project dialog.
- **Canvas controls** — LMB=brush, RMB=pan, MMB=toggle autoscroll (anchor + speed-by-distance pan; Esc to exit), scroll=zoom, Ctrl+LMB drag=resize brush (the dragged dimensions adapt to the brush shape), Ctrl+wheel=cycle input mappings, Shift+RMB=open in-page color picker at the cursor, Shift+LMB=open Inspect Cell popup (live attribute readout + RGB; draggable and stackable for comparing cells; hover to highlight the linked cell), Shift+LMB drag=sweep inspect (a single transient popup follows the cursor cell and is discarded on release
- **Brush tool** — configurable color (with live R/G/B channel inputs beside the picker), **shape** (Rectangle W×H / Circle radius / Ring radius+width / Line two-click segment of a chosen thickness), and input mapping. The brush cursor traces the exact cells the stamp will affect and is drawn as a photographic **negative** of whatever is behind it (Windows-cursor style), so it stays visible over any cell palette. Ctrl+drag resizes the active shape's parameters.
- **Manual Brush** — always-available "Manual" tab in the brush mapping strip lets you paint cell attributes directly without authoring a Color→Attribute mapping. One row per cell attribute with a "Set" checkbox and a type-appropriate value widget (binary dropdown / number input / tag dropdown / a clickable neighbor-offset grid for NeighborIndex attributes); unchecked attributes are skipped at paint time. Sub-attributes follow per-cell skip semantics — a sub-attribute write only lands on cells whose effective parent value (brush value if also Set, else the cell's current value) matches `parentValues`. Configuration persists per-model.
- **Region clipboard** — Ctrl+C/V/X on the simulator copy/paste/cut all cell attributes within the brush footprint; the copy follows the brush **shape** (a circle copies a disc, a ring an annulus), and paste stamps that shape centred on the cursor, leaving the surrounding cells untouched
- **Viewer tabs** — horizontal bar at the top to switch between Attribute-to-Color visualization modes; hovering a viewer tab (or a Color→Attribute brush tab) shows the mapping's description as a tooltip
- **Resizable right panel** — the right panel stacks the brush settings (Input Mapping) above the Indicators; when the model has indicators, drag the divider between them to give the indicators more room (double-click resets it to fit-the-brush)
- **Load lands in the Simulator** — opening a project (by **Load** or from the **Library**) jumps straight to the Simulator with a brief load confirmation; the top bar then shows the project name with the source file name in parentheses, so multiple versions of the same project are easy to tell apart
- **Cell inspector** — Shift+LMB opens a live attribute readout; NeighborIndex attributes decode to their `(dr, dc)` offset (not the raw packed integer), and variegated models show the cell's orientation as an extra row
- **Glyph overlay** — the unified **Set Cell Looks** node (with **Use glyph** on) paints a Unicode character on top of each cell (any character, in any RGB colour). Per-cell glyph + colour are computed by the same node graph as the cell colour, so patterns like `GetOrientation → Switch → SetCellLooks(↑→↓←)` show per-cell facing direction at a glance. Optional **background colour** (shown at every zoom, behind the glyph) and **glyph colour when zoomed out** (paints each glyphed cell with its glyph colour once cells are too small to draw the character) keep the macro view meaningful — no second output mapping. Cached pre-rasterised tiles keep the close-up fast.
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

- [Node Reference](docs/NODES_REFERENCE.md) — full catalogue of all 115 node types (including the Bond-Graph Agents family), port schemas, and compile-time semantics, with Mermaid diagrams of common patterns.
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
| `npm run generate-pwa-assets` | Regenerate the PWA icon set from `public/icon.svg` |
| `npm run tauri build` | Build the native desktop app (needs Rust — see below) |

### Native desktop build (Tauri)

A [Tauri v2](https://v2.tauri.app) shell in `src-tauri/` wraps the same web build in a lightweight native window (the OS webview — WebView2 on Windows). It builds a **standalone portable `GenesisCA.exe`** — no installer (`bundle.active: false`); the PWA is the main install path, and the exe is for running offline from anywhere, e.g. a USB stick. The native version is read from `package.json`, so it always matches the web app.

Building needs the [Rust toolchain](https://www.rust-lang.org/tools/install) (`rustup`) in addition to Node — on Windows, WebView2 ships with Windows 10/11. With Rust installed:

```bash
npm run tauri dev                  # run the app in a native window
npm run tauri build -- --no-bundle # produce the portable exe (target/release/genesisca.exe)
```

CI builds and publishes the portable Windows `.exe` to [Releases](https://github.com/rff255/GenesisCA/releases/latest) on every `v*` tag (`.github/workflows/release.yml`). It's unsigned, so the first run shows a Windows SmartScreen prompt — click **More info → Run anyway**.

> Note: WebGPU is only guaranteed on the Windows (WebView2/Chromium) native build; macOS/Linux Tauri builds use WebKit, where the simulator falls back to the WASM/JS compile targets.

### Tech Stack

- **TypeScript + React** — UI framework
- **Vite** — build tool and dev server
- **React Flow** — node-based graph editor
- **Canvas2D** — grid rendering
- **Web Workers** — off-thread simulation engine
- **vite-plugin-pwa + Workbox** — installable, offline-capable PWA (service worker + manifest)
- **Tauri v2** — native desktop shell (standalone portable `.exe`; cross-platform capable)
- **CSS Modules** — scoped component styling

---

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

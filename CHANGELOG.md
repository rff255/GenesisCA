# Changelog

All notable changes to GenesisCA are documented here. The newest release is at
the top. Full commit history and older releases:
https://github.com/rff255/GenesisCA/releases

The version at the top of `package.json` is the single source of truth; each
entry below is cut when that version is tagged (see `.github/workflows/release.yml`).

## [1.30.0] - 2026-08-09

A large release headlined by two milestones — a **Clarity & Simplification**
sweep that makes the engine legible (one Engine selector, a declared
reproducibility contract, a compatibility readout, a generation-pipeline panel,
fast-path diagnostics) and **Graph-Rewriting Automata**, a full agent-tier
rewriting layer (census → table → verb) with typed bond attributes, an atomic
structural request queue, and three flagship samples — plus deterministic
long-range charge, rule cadence, a reworked agent Glow, 3D copy/paste, and a
broad simulator/modeler polish pass. Additive throughout: the lattice (2D+3D,
all three compile targets) and every existing model stay byte-identical.

### Clarity & Simplification (C1–C11)
- **One Engine selector** — Auto / WebAssembly / WebGPU with Debug (JS) behind an
  Advanced reveal; Auto resolves the fastest engine that satisfies the model's
  declared reproducibility contract, and Show Code always displays the JS
  reference source.
- A **declared reproducibility contract** (Exact | Statistical) governs update
  mode and engine; a **Compatibility readout** and a **Generation Pipeline panel**
  in Properties explain, per layer and per engine, which engine runs and what each
  generation does — both copyable as plain text.
- **Fast-path diagnostics** in the simulator report which fast paths (GPU
  residency, sparse stepping, field bridge, direct render) actually engaged, with
  a generated engine-capability matrix in Help.
- **Archetype-first New Model** (a card chooser that seeds a coherent model),
  seeded engine draws so every simulation-semantic random is reproducible, a
  **presentational-geometry taint check** that labels layout physics that don't
  affect your rule, and profile-gated agent SoA fields with a Static integrator.
- **Deterministic Barnes–Hut GLOBAL charge** (a second, cutoff-free charge law) on
  all agent targets.

### Graph-Rewriting Automata (GRA)
- A **Neighbour State Census** node — the order-independent multiset of neighbour
  states a graph rule reads — lowered to existing nodes, so it runs on all three
  agent targets with zero per-target emit.
- **Bond attributes**: per-edge user state on JS, WASM and WebGPU, with a
  symmetric-by-construction store and Form-Bond initial-value ports.
- An **atomic structural request queue** with the degree-preserving **Rewire
  Bond**, third-party **Form Bond Between** and in-place **Transfer Bond** verbs,
  plus a declarative **division bond partition** and daughter-bond policy.
- **Graph indicators** (node/edge counts, degree stats, component count) as a live
  measurement layer, wired into the Overseer for rule-space sweeps.
- Flagship samples: **Cubic GRA**, **SDCA — Couplers and Decouplers**, and
  **Growing Graphs** (Paul Cousin's binary cubic GRA, ported from znah's demo with
  physics + slot-order fidelity).
- Sync agent update mode is now honoured on the **WebGPU** agent target.

### Agents
- **Set Agent Sprite** runs on WASM and WebGPU — the last agent-target node gap
  closes, so every agent node emits on all three targets.
- **Sense Hemifield** now outputs the agents on each side, not just the counts.
- The agent brush gains **Push / Pull** (a radial force with a magnitude-scaled
  cursor and Ctrl+drag two-axis retune) and drops the little-used Bond mode.
- **Rule cadence** — Get Generation + Periodic Step — and **layoutIterations** (run
  the force integrator N times per generation) join **long-range charge** for
  graph-layout control.

### Agent Glow
- Glow is reworked end to end: a **solid core** so agent colours never blow out,
  **CPU-overlay** rendering so bonded models (tissues, GRA) glow too, **screen
  blending** so dense cluster halos stop saturating, and **antialiased disc
  edges**.

### Simulator
- **Interruptible step batches** — a high Gens/Frame no longer costs you the UI;
  pause and speed changes land promptly.
- **One capture area** for screenshots and recordings, a **Copy** action on the
  screenshot, cursor + highlight rings optionally included in captures, WebM
  recordings that **play back at the speed recorded**, and simulation-scope
  capture that records the grid again on every GPU path.
- The canvas **re-sizes during a panel drag** instead of after the next
  interaction, an **enabled control always does something** (structurally inert
  ones are hidden), and informational toasts read as info, not warnings.
- 3D: bonds no longer draw in front of agents when zoomed out, the brush plane is
  occluded by cells in front of it, a **Blender-like gizmo** with numpad view keys,
  a view-anchored default key light, and opt-in **2D smooth scaling**.

### Modeler
- The **Expression node** draws its formula as typeset maths, leads with the
  rendered formula, is resizable, and hides its input-name editors until needed.
- **Get Random** gains intervals, distributions and a vector mode; the **Math** node
  gains Negate.
- **Copy and paste node graphs between browser tabs**, the minimap draws nodes in
  faded versions of their real colours and marks the viewport with a rectangle,
  the Modeler/Simulator mode tabs carry icons, **2D parametric neighbourhood
  generation**, and the Agent Output Mappings panel matches the CA-grid one.

### Library, Save & thumbnails
- The **Save dialog edits the model's title and authors**, not just the filename.
- Library cards gain a clickable tags row on the hover popover (which now survives
  the whole popover), an **authored creation date** (not the file's mtime), and
  **video/webm** model thumbnails.

### 3D copy/paste
- Cell and agent **copy / paste / cut work in 3D**, anchored on the brush plane.

### Fixes
- A pasted graph with dangling references now **errors instead of white-screening**.
- A canvas re-attach swaps the agent render pipelines atomically (no stale blink);
  3D agent wireframes depth-test against agents.
- **Get Indicator** can read graph + linked-total indicators; a rounded f32 max
  literal that killed every min/max shader is emitted representably; the reorder
  drag handle is legible in both themes.

## [1.29.0] - 2026-07-30

A big release headlined by **GPU-resident agent rendering** — agents-only and
decoupled grid+agents models now draw whole frames on the GPU, freeing the main
thread when nothing needs per-frame CPU state — alongside a **follow camera**,
**CSV import**, **streaming video recording**, and **binary Save As** in the
desktop build. Additive throughout: the lattice (2D+3D, all three compile
targets) and every existing model stay byte-identical.

### Agents — GPU-resident rendering
- A new render path lets the worker draw agents directly into a transferred
  canvas: **2D discs** (A1) and **snapshot-fed CPU targets** (A2), the
  **3D free-mode sphere render** (C), a **single-canvas grid+agents composite**
  at display resolution (E2), and **field-decoupled grid+agents residency** (D).
  While no feature needs per-frame agent state the free-running cost drops to a
  single blit; pausing, recording, inspecting, or brushing flip the readback back
  on automatically.
- A **unified GPUDevice** now serves every WebGPU runtime (E1), and a
  buffer-copy **field bridge** (E1b) keeps field-coupled Chemotaxis/Ant models
  resident. Agent **Output-Mapping colours** compile to a GPU pass (A1.5), and a
  decoupled grid+agents model on a WebGPU grid runs its agents on the GPU (M4).
- New **agent Glow** graphics option (WebGPU direct render).

### Agents — engine performance
- **PR7c GPU residency**: eligible models run whole frames on-GPU (GPU-built
  spatial hash + persistent SoA + one readback per frame) — ~29× on 50k Particle
  Life. The dead **density scan** is skipped when nothing reads it, per-thread
  WebGPU scratch is capped, sub-2px discs point-splat, and the render snapshot is
  Float32.
- Fixed the **"WebGPU wrong dynamics"** bug by serializing async step batches, and
  a resize no longer desyncs the agent compiler's baked dimensions.

### Simulator — follow camera + inspect
- **Follow mode**: a pinned agent inspector's ◎ toggle tracks that agent (2D+3D),
  driven by a critically-damped spring plus a filtered velocity feedforward that
  cancels tracking lag by construction — replacing the deadzone-edge ease.
- Agent inspectors are now **multi + draggable** with a Close-all; every open
  popover keeps its highlight ring, and rings follow their moving agent. Loading
  a model closes every inspect dialog.

### Simulator — CSV import
- A new **Import CSV** dialog brings tabular data into a running simulation:
  **Agents** (one row per agent, auto-mapped columns) or the **CA grid** (a line
  is a row, a field is a column). A **no-delimiter** mode reads ASCII-art boards
  where every character is a cell, with an editable char→value map. Zero compiler
  impact — verified across every compile target.

### Simulator — recording
- WebM recordings now **stream** (encode-as-you-go) instead of buffering raw
  frames, so long captures stay memory-bounded. Added **quality modes**
  (GOP-30 default), a **lossless capture policy** that throttles the sim instead
  of dropping frames, and a residue-based VP9 profile-1 guard.
- **Capture scope** selector (current view vs the whole simulation at a fit
  framing, zoom-independent) for both recording and screenshots.

### Simulator — vision cones & UX
- **Vision-cone display** for the FOV sensing nodes (Off / Inspected / All), with
  per-node cone colour and a hemifield-boids sample.
- **Simulator Instructions** (author-written usage notes), a preset **… menu**
  with Rename, **preset export/import** (.gcapreset), **drag-and-drop** files onto
  the app, and the capture controls moved off the transport bar to the canvas
  bottom-right.

### Nodes
- **Vector Op** gains **Rotate (2D)** and **Rotate Around Axis** (Rodrigues, 3D),
  lowered to scalar arithmetic so all three targets run them.

### Desktop build
- **Binary Save As** for the Tauri build — recordings, screenshots and every
  other download now write through a chunked native IPC (previously silently
  dropped by WebView2), with an honest cancel-vs-failure split.

### Models
- **Ant Necrophoresis** rebuilt as discrete and exactly mass-conserving.
- Library **compile-target policy**: WebGPU where the gates accept it, else WASM;
  Kelp War ships on the WebGPU grid target.

### Fixes
- Fixed agent value placement (branch scope and RNG draw order) so the JS and
  WASM agent targets stay bit-identical.
- A panel resize no longer shows a frozen, outdated frame under direct render.
- Vision cones drew as circles because the snapshot wasn't shipping velocity; the
  Instructions pill is hidden in the standalone viewer; capture-popover text
  rendered literal escape codes.
- Plus a wide **quick-wins batch**: Math floor/ceil/round ops, lookup-table
  Randomize Min, per-agent sprite alpha, reroute default names, collapsible
  Properties sections, transport FPS/G-F popups, a 2D axes indicator, and more.

## [1.28.0] - 2026-07-22

Headlined by **Particle Life** — two new library samples plus the matrix-play
editing UX that makes interaction tables fun to tinker with — alongside a faster
2D agent renderer and a handful of fixes. Additive throughout: the lattice
(2D+3D, all three compile targets) and every existing model stay byte-identical.

### Particle Life
- Two new library samples, **Particle Life** and **Particle Life 3D**, built from
  one parameterized generator and faithful to the classic force law: a per-pair
  repulsion core, a tent-shaped attraction band, and three asymmetric
  species×species tables (rules / attractMin / attractMax). Agents-only, torus,
  graph-side friction, with live sliders for particle count, force factor, repel,
  friction and query radius, plus four named matrix presets.

### Lookup tables — matrix play
- Float tables now open in a **matrix view**: a diverging red/cyan grid you can
  drag-adjust per cell, click or Ctrl-click to select, and nudge with a shared
  slider (one cell, a selection, or the whole matrix). Available in both the
  Attributes panel and the simulator's live Model Attributes section.
- Square tables gain a **Fill pattern** catalogue (snake, rock-paper-scissors,
  chains, bipartite, hubs, shells, swirl, dimers, triad flocks, symmetric and
  uniform random) plus Zero / Symmetrize / Transpose / Negate / Mutate.
- **Randomize** accepts a signed range, so a rules matrix can roll uniformly in
  −1..1. Omitting the range reproduces the previous (0,1) draw bit-for-bit.
- Lookup-table axes and value-tag sources can now bind **agent** tag attributes,
  not just cell/model ones — with rename, reorder and removal cascades.

### Agents — rendering
- Fully opaque agent discs now render through a **batched path** that groups by
  colour and radius, roughly 2.5–3× cheaper to draw at several thousand agents.
  Any translucent agent falls back to the exact per-agent path.
- New **Outlines** toggle (default off) controls the dark disc contour in 2D and a
  matching silhouette rim on the 3D sphere impostors.

### Fixes
- Two latent JS-target agent parity bugs, both surfaced by Particle Life: the
  agent graph never ran the lookup-table geometry pre-resolve (so Table Lookup
  read the wrong cells of any multi-column table on JS), and Get Agent Offset's
  Distance used `Math.hypot` where WASM used a squared-sum sqrt, diverging by
  ULPs. Get Curvature carried the same hypot pattern and is fixed alongside, with
  a permanent parity synthetic.
- The lookup-table Fill-pattern select rendered with invisible, clipped text, and
  the Randomize row no longer breaks its label/field pairs across lines.
- The standalone export viewer's reopen button is now labelled **ⓘ Info**.

## [1.27.0] - 2026-07-17

A large release headlined by the **Overseer** — a third graph for experiment
orchestration — plus **N-dimensional lookup tables**, a **large-grid stepping**
optimization that unlocks 300³ models, authorable **RGBA alpha** through the whole
colour chain, a much richer **3D viewport**, and a self-contained **standalone
`.html` export**. Additive and gated throughout: the lattice (2D+3D, all three
compile targets) and every existing model stay byte-identical.

### Overseer — experiment orchestration (the third graph)
- A new opt-in **Overseer** graph authors experiment protocols AROUND the
  simulation — replicate statistics (N seeded runs → mean ± σ), parameter sweeps,
  run-until-stop protocols, and capture — as an async main-thread driver that
  commands the sim worker through the existing message protocol, so the CA keeps
  running on whichever compile target the model selects. Fully hidden when off.
- 20 experiment nodes (run control, measurement, data/stats, capture), a
  reqId-correlated runtime, and an **Overseer Experiments** simulator panel with a
  live Journal, Series table, scalar-series **histograms**, **spatial aggregate
  charts** (per-bin mean ± σ chromatograms), and CSV/JSON export.
- Ships the **GoL Replicate Statistics** tutorial sample and a built-in
  Chromatography replicate experiment (the paper's Fig. 3 as an ensemble average).
- `setRngSeed` is now a first-class worker message that reaches the WASM RNG cell
  and the WebGPU per-cell PCG streams, so seeded experiments are bit-reproducible on
  JS/WASM and statistically reproducible on WebGPU.

### N-Dimensional Lookup Tables + the Accretor
- Lookup tables generalise from 2 axes to **1–6 axes** (with an integer-range axis
  kind) plus a **seeded Randomize** fill — all lowered to one flat dense read, so
  every compile surface runs multi-axis tables with no new runtime machinery. Custom
  axis labels and a selectable value type (bool/integer/float/tag) are authorable.
- New **Accretor** sample — a 300³ 3D accretion automaton whose rule is a 4-axis
  table — with random and mirror-symmetric seeding and an Overseer Rule Explorer.
- The Overseer **Randomize Table** node re-rolls a table's values at runtime for
  automated rule-space search.

### Large grids — Skip Isolated Empty Cells
- Opt-in **Skip Isolated Empty Cells** turns the O(total cells) step into
  O(active cells) — only cells within range of a non-empty cell run the rule — and
  replaces the multi-GB precomputed neighbour tables with inline neighbour
  computation (JS + WASM). Off by default → every model byte-identical.
- With incremental linked-indicator maintenance and batch-tail scan deferral, the
  Accretor runs at **300³ (27M cells)** — inits in ~1.9 s and steps interactively —
  where the full loop was impractical. A live "N active" stat shows the saving.

### RGBA colours (authorable alpha)
- Alpha now flows end-to-end from every colour producer to the colour buffer on all
  five compilers (JS/WASM/WebGPU × cell + agent), 2D + 3D: a colour model-attribute
  alpha slot, an `a` output on Color Scale / Categorical Color / Colour Constant
  (gated so opaque palettes stay byte-identical), and alpha-aware linked Output
  Mappings.
- One shared **ColorField** picker (checkerboard swatch + alpha slider, portalled
  out of the transformed canvas) replaces seven bespoke pickers; the gradient
  editors no longer drop alpha.

### 3D viewport
- **Agent metaballs** — fused implicit-surface agent rendering (3D raymarch + a 2D
  gooey filter), with per-voxel translucency inherited from local agents.
- **Global lighting** — opt-in cast shadows (shadow map) + occupancy ambient
  occlusion, plus library/viewport lighting controls and a cell-gaps toggle.
- **Auto-zoom** — a one-way dolly companion to auto-orbit (stops at the distance
  limit) for unattended recordings.
- Occlusion culling (cube backfaces + buried voxels), 3D agent Glue/Cut/Bond with a
  brush-outline cursor and Alt-scroll mode cycle, axis dimension labels, and a fix
  for voxel cell-index corruption past 2²⁴ (~16.7M) cells.

### Standalone export + sharing
- **Export standalone simulation…** bundles the simulator + one model into a single
  self-contained `.html` that runs offline from a bare `file://` — with a welcome
  modal, Open Graph / Twitter link-preview tags, and a human-readable banner so
  chat attachments preview as a title card instead of minified code.

### Modeler + VPL
- **Get Grid Dimensions** — a universal node exposing the world's Width / Height /
  Depth (plus optional Center X/Y/Z = ⌊size/2⌋) on both the Cells and Agents graphs,
  so a rule can be written independently of the grid size.
- **Grid Init Event** — global once-per-Reset procedural seeding (loop + Set Cell at
  Position), the free-form counterpart to the per-cell Init Event.
- **Loop node** gains an **Index** output (the 0-based counter) and a **Range mode**
  (From..To inclusive) on all compile surfaces.
- **Multi-attribute slots** on Get/Set Attribute (read/write N attributes through one
  node) and **cross-agent writes** — Apply Force To Agent(s) (commutative, race-free)
  plus a sync-mode overwrite gate.
- Agent-graph node labels de-noised (`agentLabel`), field-bridge nodes marked, and
  Set/Set-Agents Attribute widgets adapt to the picked attribute's type.

### Simulator + library
- A canvas-toolbar **Inspect toggle** (plain-click inspects cells/agents, 2D + 3D)
  with inspect-mode drag sweeps; a **Bonds** display toggle in the Layers panel;
  indicator header controls visible from load with a spatial-chart Lines/Bars toggle.
- Library browse tools — topology filters, roomier cards, a two-pane hover preview,
  and 3D/Agents mode badges that act like tags.
- Fixes: parameter-only presets no longer resize the grid or overwrite the model's
  default dimensions; constant-width agent contours; the tag lookup-table Randomize
  "Max" now round-trips and the Simulator table editor stops resetting it to 1; the
  Chromatography sample restored to its hand-organized layout with only the Overseer
  layer added; the PWA no longer self-reloads mid-session (deferred `'prompt'` SW
  update); and a batch of agent/3D fixes (depth option, cursor overlay layer,
  cross-model leak, save-dialog memory, agent slot hygiene).

## [1.26.1] - 2026-07-08

The Agent Capability Profiles milestone plus a large agent-platform push: opt-in
capability modules, a stored vector attribute type, unified spawning, directional
sensing, real positional collision, 3D agent sprites, and agent Stop Events on
every target. Additive and gated throughout — the lattice (2D+3D, all three
compile targets) and every non-agent model stay byte-identical.

### Agent Capability Profiles
- Agents are now composed from opt-in capability modules (Motion, Body, Collision,
  Bonds, Growth, Division, Lifespan, Sensing, Orientation, Field coupling,
  Appearance) via 7 presets (Particle, Boids, Vivarium, Morphogenesis, Social
  Graph, CA-on-Agents). The editor surface — palette nodes, Behaviour-Step ports,
  Edit-panel rows, inspector fields — shows only the capabilities a model uses, so
  a social-graph author never sees morphogenesis nodes. Legacy files infer their
  profile from usage and stay byte-identical.
- The physics capabilities now drive the ENGINE, not just the palette: Collision
  (Off / Soft-sphere / Positional), Bonds (Off / Data / Physics), and Growth each
  gate real behaviour on all three targets — fixing "false choice" controls (e.g.
  a positional-collision gas whose agents passed through each other).
- Real **Positional (hard) collision** — a rigid no-overlap position-projection
  constraint (billiard-ball), distinct from the springy soft-sphere force; a
  target-independent CPU post-step, bit-identical on JS/WASM and statistical on WebGPU.
- New Lifespan **Get Age** node.

### Agents — sensing, spawning, orientation
- **Directional sensing**: Get Agents In View (a heading-relative vision cone) and
  Sense Hemifield (the Braitenberg Left/Right split of that cone — steer by
  Left − Right). All three targets, 2D + 3D.
- **Unified spawning**: Create Agent → set-by-handle → Add Agent To World now works
  in BOTH the Agent Init Event AND the Behaviour Step (spawn during the run — e.g.
  a bird lays an egg), with full instance control, on JS / WASM / WebGPU. Replaces
  the earlier request-based Spawn Agent / Spawn Event idiom.
- **Stored vector attribute type** for cell + agent attributes and Local Variables
  (2D/3D), lowered to scalar-float components so every target runs it natively
  (own / neighbour / by-id reads + writes + move); the FOV nodes can steer by a
  stored **Facing** vector attribute (the Orientation capability).

### Agents — 3D sprites + Stop Events
- **3D agent sprites**: sprite-agents render as camera-facing textured billboards
  in the voxel view (a texture-array atlas, per-agent frame / rotation / aspect /
  scale), closing the last 3D-renderer gap. Non-sprite models are byte-identical.
- **Agent Stop Event** now fires on the WASM and WebGPU agent behaviour (was
  JS-only), with correct ordering across the cell + agent steps in every batch loop.

### Simulator
- The Agent Brush panel now sits ABOVE the Indicators (like the CA-grid brush),
  with a shared draggable splitter between them and a sensible default height so
  the indicators stay visible — fixing a layout where the indicators dominated the
  panel and the brush was unreachable with no resize.
- The agent brush Single/Area scope is now DERIVED from the brush size (radius 0 =
  Single, > 0 = Area) with a live badge next to the size, replacing the toggle; the
  Shape + size rows moved above the mode buttons.

### Modeler
- Macro-availability gate: a macro whose internals can't run on the active graph (a
  lattice macro on the Agents graph, or a bond-graph macro on Cells) is hidden from
  the palette.
- Set / Set-Agents Agent Attribute adapt their inline value widget to the picked
  attribute's type (bool → select, tag → named options, number).
- Design-time badge for the Init-Event footgun: an agent node that reads agent
  state placed in the Agent Init Event (where it would crash) is flagged, guiding
  spawn-and-configure-by-handle instead.

### Fixes
- Two adversarial-review rounds hardened the agent work: the init-footgun badge was
  corrected (every by-id agent reader is unconditionally invalid in the Init Event —
  `highWater`/`_alive` aren't in the init ABI) and Set Agents Attribute relaxed to
  match its sibling setters; an agents-only project macro now reaches the palette; a
  scaled sprite's pick region and a shared stop-flag clear were fixed.
- Vector-attribute adversarial fixes (guard gaps, UI validation, array-kind reset).
- Capability / bonding reconciliation with the legacy checkboxes; a full reinit when
  the effective bond stride changes.

### CI / tooling
- Changelog-driven GitHub Release notes; `/updateversion` auto-generates the
  CHANGELOG section, supports a `commit` flag, and prints a ready-to-paste PR message.

## [1.25.0] - 2026-07-06

Agent & CA-grid UX batch. Additive and gated throughout — the lattice (2D+3D,
all three compile targets) and every untouched model are byte-identical.

### Agents — brush parity (2D + 3D)
- Full agent brush matching the CA-grid brush: shapes (rect/circle/ring/line,
  volumetric in 3D), Single/Area scope, and modes Add/Remove/Move/Edit/Glue/Cut/Bond.
  Edit reuses the manual-value panel plus geometry rows; `paintAgents` gains an
  optional `geom`.
- Affected-agent highlighting under area brushes, a visible Bond scan-radius
  cursor, brush-cursor visibility parity (with a "Show brush cursor" toggle), and
  an agents-only 2D environment background.
- Topology-aware Layers/brush target; the brush honours the environment bounds
  (no acting or cursor in the letterbox when infinity is off).
- Perf: rAF-coalesced cursor redraws (skipped while playing); a main-area click
  restores keyboard focus so transport shortcuts work.

### Agents — sprites
- Agent sprites: rotation (per-sprite default direction, orient-to-velocity,
  per-agent angle/vector via Set Agent Sprite), scale override, chroma-key
  (pick-from-image), image sequences, and sprite sheets. Set Agent Sprite is now a
  by-id setter (safe no-op in the Init Event).
- Recording fixes: persistent post-recording slowdown (display/blit-source canvas
  de-opt) and stale-trail / stale-agent-on-load artifacts.

### Simulator
- Map Image to Cells dialog (replaces Open-Image): region box + cell-reference
  alignment, zoom/pan viewport, resize-grid vs paste-centered, optional
  manual-input mapping, and Ctrl+V paste. 2D-only.
- Presets: drag-to-reorder and duplicate. Duplicate buttons for
  attributes/variables/mappings/indicators (cell + agent). Indicators: a
  Clear-chart button and a selectable time-axis Window (always bounded, at most
  5000 samples per series).

### Lookup Tables
- User-editable custom row/column labels (kept unique — no ghost columns) and a
  selectable value type (Binary checkbox / Integer / Float / Tag, with tag values
  from an existing attribute). Enables a Golly-style Born/Survive sample with no
  placeholder tag attributes.

### Modeler UX
- Cleaner CA-grid vs Agents separation: Neighborhoods tab elided for agents-only
  models, Mappings panel grouped by topology, all event-root nodes rendered white.
- Graph-aware tag / own-attribute resolution for universal nodes on the Agents
  graph (agent attrs + agent-accessible cell fields), fixing empty tag dropdowns
  and missing value widgets.
- Field-bridge nodes (sampleField/fieldGradient/readCellsUnder/affectCellsUnder/
  secreteToField) gained config UI so field logic is buildable in the modeler.
- Dropped the Randomize action; per-model save defaults.

### Fixes
- Hardened screenshot capture and fixed an agent-WebGPU `GPUDevice` leak
  (load-lifecycle audit).
- Docs sweep (CLAUDE.md batch section, README, in-app Help) and library-model
  updates, including a Game of Life "bumblebee" initial state.

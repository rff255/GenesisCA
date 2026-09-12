# Project structure — the annotated file tree

> Area doc for **GenesisCA**. The full annotated tree of src/, scripts/, docs/ and public/. Read when you need to find where something lives, or when adding a file that needs a tree entry.
>
> **Also read** — a change here usually reaches [`architecture.md`](architecture.md).
> Keep following those onward until a pass turns up nothing new; the reading is not done at the first
> doc that answers your question. See *Read to CLOSURE, not to the first hit* in `../../CLAUDE.md`.
>
> Sections below were moved **verbatim** out of `CLAUDE.md` (2026-09-06) so the always-loaded
> file could stay small. Nothing was rewritten or deleted. See `../../CLAUDE.md` for the
> project-wide rules and the routing table, and `docs/HANDOFF_*.md` for the full build narratives.
>
> **Paths here are repo-root-relative** (e.g. `src/model/types.ts`), exactly as they were in `CLAUDE.md`.
> Read them from the repository root; they will not resolve as links from this directory.

**Contents**

- Project Structure

---

## Project Structure

```
genesis-ca/
├── CLAUDE.md
├── package.json
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── vite.config.ts
├── index.html
├── pwa-assets.config.ts             # PWA icon-set generator config (source: public/icon.svg)
├── public/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── FileMenu.tsx              # New/Save/Load buttons
│   │   ├── NewModelDialog.tsx        # C7 (P6): the File→New archetype chooser (cards → one seeded NEW_MODEL)
│   │   ├── InstallButton.tsx         # Navbar PWA install affordance (beforeinstallprompt/appinstalled)
│   │   ├── ThumbMedia.tsx            # The ONE model-thumbnail renderer — <video> for a WebM clip, <img> otherwise
│   │   ├── MacroExportDialog.tsx     # Export Macro… — the per-element opt-out over the collected references (embed by default)
│   │   ├── SpriteSheetDialog.tsx     # Sprite-sheet gridding: the first-cell GIZMO + grid params + WHICH cells, in WHICH order, are the animation
│   │   ├── SpriteCropDialog.tsx      # Sprite CROP for NON-sheet assets (image / GIF / frame sequence): the pan-zoom viewport + crop-box gizmo + numeric rect
│   │   └── navStyles.ts              # Shared navbar icon-button style (shortcuts, Install)
│   ├── modeler/
│   │   ├── ActivityBar.tsx           # Left panel-switch tabs — floating "ear-tab" icon pills (SVG icons)
│   │   ├── RightActivityBar.tsx     # Right ear-tab pills (Explorer + Palette)
│   │   ├── PanelShell.tsx            # Panel wrapper (header + scrollable body)
│   │   ├── ModelerView.tsx
│   │   ├── ModelerDetailContext.tsx  # Per-panel detail selection (master-detail 2nd panel)
│   │   ├── modelerUiState.ts          # Module-global snapshot of ModelerView panel/selection state (survives tab-switch unmount)
│   │   ├── panels/                   # Panel content components
│   │   │   ├── InfoPanelContent.tsx      # Info tab: model presentation metadata (name/authors/description/thumbnail/tags)
│   │   │   ├── PropertiesPanelContent.tsx # Properties tab: a thin SHELL — the Setup / Execution / Agents / Diagnostics sub-tab strip + routing
│   │   │   ├── propertiesWidgets.tsx     # The Properties primitives (SubTabs, Section, Segmented, ToggleCard, FieldRow, Advanced, Badge, Callout, CopyButton…) + the `genesis-open-modeler-panel` event
│   │   │   ├── PropertiesSetupTab.tsx    # Setup: Layers (Grid Cells / Bond-Graph Agents cards) · Space (dimension / size / boundary — ONE frame shared by the cell lattice AND the agent world, so it is ungated) · Extensions (Variegated / Overseer / GIS cards)
│   │   │   ├── PropertiesExecutionTab.tsx # Execution: Reproducibility · Grid engine (update mode + Engine segment, Debug JS + stop-check under Advanced) · Agent engine · Performance · Reset (only when the model carries a saved board)
│   │   │   ├── PropertiesAgentsTab.tsx   # Agents (only while the layer is on): Capability profile (each row owns its knobs) · Population (Max bonds greyed under Bonds=Off) · Motion (rows greyed per Motion mode) · Advanced (layout iterations, bond request depth)
│   │   │   ├── PropertiesDiagnosticsTab.tsx # Diagnostics: the read-only Compatibility + Generation Pipeline readouts (+ Copy) and the per-agent footprint
│   │   │   ├── IndicatorsPanelContent.tsx # Indicators tab (its OWN left-bar panel): the IndicatorsPanelSection list + End Conditions; master-detail
│   │   │   ├── EndConditionsSection.tsx  # End Conditions (max generations + indicator conditions), extracted verbatim from the old Properties panel
│   │   │   ├── AgentCapabilitiesSection.tsx # Agent Capability Profiles: the preset picker + capability rows, EACH OWNING ITS TUNING KNOBS (Collision → μ_R + interaction range / positional iterations; Adhesion checkbox → μ_A; Bonds=Physics → λ + rest length + auto-bond + form/break; Growth → rate; Sensing → neighbour query radius; Charge → its knobs) (rendered by Properties › Agents › Capability profile; the footprint readout lives in Diagnostics)
│   │   │   ├── AttributesPanelContent.tsx
│   │   │   ├── NeighborhoodsPanelContent.tsx  # (3D: renders Neighborhood3DEditor; 2D: Neighborhood2DParametric + the hand-editing grid)
│   │   │   ├── Neighborhood3DEditor.tsx   # 3D Grid CA: parametric + slice-stack neighbourhood editor
│   │   │   ├── Neighborhood2DParametric.tsx # 2D parametric neighbourhood generator (the 2D twin of the 3D Parametric block)
│   │   │   ├── NeighborhoodPreview3D.tsx   # 3D Grid CA: live orbiting neighbourhood preview (reuses Gl3DRenderer)
│   │   │   ├── neighborhood3d.ts          # 3D Grid CA: pure generateCoords3d (named shapes + metric)
│   │   │   ├── neighborhood2d.ts          # pure generateCoords2d — the dl===0 slice of generateCoords3d (no duplicated shape math)
│   │   │   ├── MappingsPanelContent.tsx
│   │   │   └── PalettePanelContent.tsx  # Palette tab: nodes + default + project macros
│   │   └── vpl/                      # Visual Programming Language editor
│   │       ├── CaNode.tsx            # Custom React Flow node component
│   │       ├── RerouteNodeComponent.tsx # Tiny pass-through reroute dot (editor-only; collapsed at compile time)
│   │       ├── types.ts              # Port/node type definitions
│   │       ├── GraphEditor.tsx
│   │       ├── graphState.ts          # Shared mutable state (avoids circular imports between GraphEditor/CaNode)
│   │       ├── alignmentSnap.ts        # Pure Ctrl-drag alignment-guide geometry (computeAlignmentSnap + sameGuides)
│   │       ├── bondAttrPorts.ts        # GRA P2: Form Bond's per-BOND-ATTRIBUTE initial-value ports — the ONE builder consumed by BOTH CaNode and effectivePorts
│   │       ├── explicitControls.ts     # Explicit Controls: the ONE resolver (eligibility / descriptors / chain walk / the element option lists / applyInterfaceEdit / groups) consumed by BOTH the interface editor and the closed instance
│   │       ├── nodeMorph.ts            # "Morph into": the curated retype table (Math ⇄ Math Expression ⇄ Compare ⇄ Logical Expression ⇄ Logic) + how each config/port maps; the engine lives in GraphEditor.morphNode
│   │       ├── NodeExplorer.tsx        # Right-side searchable node list panel
│   │       ├── nodes/                # 153 node types (one file each) + registry.ts
│   │       │   ├── nodeValidation.ts  # detectMissingConfig() — drives warning badges
│   │       │   ├── GridPeriodicEventNode.ts   # Cells: the GLOBAL periodic root (runs ONCE per firing generation, not per cell)
│   │       │   ├── AgentPeriodicEventNode.ts  # Agents: the GLOBAL periodic root (once per firing, NO self — spawn/sweep/stop)
│   │       │   └── colorScalePresets.ts # Named palettes (Viridis/Magma/Rainbow/…) for Color Scale + Linked mappings
│   │       ├── widgets/              # Shared inline editors (InlineWidgets.tsx, GradientStopsEditor.tsx, CategoricalPaletteEditor.tsx, ExpressionFormula.tsx)
│   │       └── compiler/
│   │           ├── compile.ts        # Two-pass compiler (hoisted values + flow). Also THE TRACE BUILD (`opts.trace`) — per-node value records, per-flow-node execution records, a single-element body, CSE + fusion off; absent ⇒ byte-identical to the pre-trace compiler
│   │           ├── traceOrigin.ts    # Rule Trace: the ORIGIN table (lowered id → user node / port / composite component / macro path) folded from the ADDITIVE `origin` map each lowering pass returns (no id is ever renamed) + `resolveTraceOrigin` + THE ONE definition of the trace ROOT KEYS (re-exported by traceProtocol.ts) + `CompileOptions`
│   │           ├── macroExpand.ts    # Shared expandMacros — flattens macro instances (all 3 targets)
│   │           ├── danglingRefs.ts   # Pre-compile gate: a NON-EMPTY config id naming a model element the model lacks (a cross-model paste / macro import) returns a NAMED compile error instead of emitting `_undef` (cell + agent graphs)
│   │           ├── volatileHoist.ts  # Shared analyzer: LCA emit-scope for getVariable-derived values
│   │           ├── asyncWriteHazard.ts # Shared analyzer: async read-after-write hazard reads (seeded into volatile set)
│   │           ├── rerouteCollapse.ts # Pre-compile pass: strips reroute relay nodes, rewires consumers to the real source
│   │           ├── multiAttrExpand.ts # Pre-compile pass: expands multi-slot Get/Set Attribute nodes (extraCount + attr_N slots) into single-slot primitives (gets split per slot, sets become a flow splice) — all 6 front-ends; also exports the editor slot-port builder
│   │           ├── expandComposites.ts # Pre-compile pass: lowers vector/color Make/Break/Vector-Op (+ Apply Force vector mode) to scalar arithmeticOperator/getConstant nodes — so all 3 targets run composites natively
│   │           ├── censusExpand.ts    # Pre-compile pass (GRA P1): lowers Neighbour Census to the gather + one Count Matching per CONSUMED state port (+ Array Length for Total) in all 3 agent front-ends — zero per-target emit; also exports the editor count-port builder
│   │           ├── densityExpand.ts   # Pre-compile pass: an ACTIVE Radius on Neighbour Density lowers it to Get Nearby Agents + Array Length in all 3 agent front-ends (zero per-target emit); also owns the activation predicate + `agentGraphReadsEngineDensity`, THE shared engine-density-consumer gate
│   │           ├── bondRequestQueue.ts # GRA P4/P4b: the per-agent STRUCTURAL REQUEST QUEUE shape (slots/base/overflow bucket, the +2 lane encoding, the NEGATIVE-break-lane Form-Between op kind, the usage gate) — the ONE definition the 4 consumers derive from
│   │           ├── bondRequestEmitJS.ts # GRA P4/P4b: the ONE JS emitter for Form / Break / Rewire / Form-Between Bond (one queue entry carries both sides, so a rewire is atomic by construction; a NEGATIVE break lane marks Form Between)
│   │           ├── dividePartition.ts # GRA P5: the DIVISION BOND PARTITION — the spec (tension / alternate / byBondAttribute + the D4 daughter-bond policy), the MODEL-derived key-sorted TABLE + the idempotent code assignment all 3 agent front-ends call, consumed by the engine's divideAgent
│   │           ├── arrayRelay.ts      # Shared makeProducesArray — context-aware "does this source emit an array?" (valueSwitch dual-mode relay)
│   │           ├── linkedOutputMappings.ts # Synthesizes the auto color pass for Linked Output Mappings
│   │           ├── agentLinkedOutputMappings.ts # Synthesizes the per-mapping agent colour-pass graph for Agent Output Mappings (reuses the cell linked-OM helpers over agentAttributes)
│   │           ├── agentAbi.ts        # Agent Capability Profiles STEP 0: the shared layout-agnostic agent ABI descriptor (deriveAgentAbi) — the ONE source the 3 CPU ABI mirrors + parity harness derive from (GRA P2 adds the _bondAttr_/_bondFormAttr_ blocks)
│   │           ├── agentWasm/compile.ts # SEPARATE WASM agent-loop compiler (reuses wasm/encoder.ts; emits its own behaviour+forcePass module over the wasmBacked AgentStore memory). FULL coverage — the WHOLE agent-graph catalogue runs on WASM with JS bit-parity (2D+3D field bridge [bilinear/trilinear + r-disk/r-sphere], array tier, structural writes, setters, universal nodes, array vars); divisionEvent+agentInit stay JS-on-CPU. Reject set = zero (only a getNearbyAgents scratch-slot budget). Heavy-rule benchmark: 2-5x faster than JS.
│   │           ├── agentWebgpu/         # PR7: SEPARATE WebGPU agent-loop compiler (layout.ts GPU agent SoA + agent-attr/request/3D-z runs + auxF32/indicators/bondStore regions, compile.ts behaviour shader + gate + full-coverage node set + 2D/3D field bridge [bilinear/trilinear], forcePass.ts 2D/3D force integrator). Runtime = simulator/engine/agentWebgpuRuntime.ts (FULL coverage DONE — Boids 2D/3D + Chemotaxis 2D/3D + GoL-on-agents + Tissue run on WebGPU; reject set = the genuine fundamentals only: median/uniform-random + order-dependent indicator ops + the agent-array-producer capacity gate. Glyph setCellLooks = parity no-op; 3D field bridge DONE).
│   │           └── overseer/compile.ts  # Overseer: compiles the experiment graph to an ASYNC main-thread JS driver (NOT a compile target — reuses per-node JS compile() for the universal value subset; own flow emitter with awaited O.* actions)
│   ├── live/                         # LIVE mode — the split workspace (graph + running simulation)
│   │   ├── liveUiState.ts            # The PERSISTED pane layout (dock / swapped / split fraction / viewportCollapsed / applyPolicy): module global + pub/sub + localStorage write-through under `genesisca_live_layout`
│   │   ├── liveState.ts              # Transient cross-tree flags: `liveLayoutLocked` (a recording is pinning the frame size), `liveShown` (published by App; GraphEditor reads it for the write-back debounce stretch), `liveFocus` (which pane owns the keyboard, set from pointerdown/pointerenter), `liveGraphDragging` (the skip-blit guard) and `overseerRunning` (greys the Live nav button) + the `LiveRuleStatus` type (ok/stale/pending/rebuild) and `dispatchCanvasFullscreen` (the shared F intent)
│   │   ├── liveKeyboard.ts           # The predicates every global key handler shares: `isTypingTarget()` and `overlayOwnsKeyboard()` (a DOM probe for an open [role=dialog] / [role=menu] — which is why every modal carries role="dialog"). NOT Live-only: the two pre-existing defects it fixes are reachable from the plain Modeler / Simulator tabs
│   │   ├── LiveSplitter.tsx          # The draggable divider (mutates the panes' inline flex, commits on release, drives simLayoutApi) + the restore ear it renders while the viewport is collapsed
│   │   ├── LiveViewportBar.tsx       # The compact bar over the viewport pane (transport chip + Apply/Later, the Auto/On-demand apply-policy switch, Settings / Controls panel toggles, the layout menu). Rendered by SimulatorView INSIDE .canvasArea so it carries `data-sim-overlay`
│   │   ├── Live.module.css           # Splitter + restore-ear styles
│   │   └── LiveViewportBar.module.css
│   ├── simulator/
│   │   ├── SimulatorView.tsx         # Canvas rendering, zoom/pan, brush tool
│   │   ├── simLayoutState.ts         # The `simLayoutApi` seam ({scheduleLayoutDraw, drawNow}) SimulatorView registers on mount — how the Live splitter, which lives outside its React tree, re-sizes the canvases without hitting the ResizeObserver-only path
│   │   ├── simTransportState.ts      # The `simTransportApi` seam (stepGeneration / play / pause / stopTrace — the transport bar's OWN handlers, never copies) + the published `playing` mirror the Trace panel's one Resume/Pause button reads. Born with Rule Trace: `App` binds `]` / `[` and cannot reach a closure inside SimulatorView
│   │   ├── ExperimentsPanel.tsx      # Overseer: the "Overseer Experiments" right-panel TAB (Run/Abort, Journal, Series table, CSV/JSON export) — one of the shared right panel's tabs (Controls | Overseer Experiments)
│   │   ├── spriteRegistry.ts         # Agent sprites: main-thread ImageDecoder→ImageBitmap[] cache (decode side)
│   │   ├── csvImport.ts              # CSV import core (pure): RFC-4180 parser, delimiter/header detection, per-attr-type decode, agent column auto-map, grid value block
│   │   ├── CsvImportDialog.tsx       # "Import CSV" dialog — Agents (row = agent) / Grid (the table IS the board) behind one Target switch
│   │   ├── CsvExportDialog.tsx       # "Export CSV" dialog — the mirror; serialises ONE fresh `getState` snapshot (same Target switch)
│   │   ├── IndicatorDisplay.tsx      # Indicator values display in simulator
│   │   ├── InspectBondPopover.tsx    # Bond (edge) inspector — select a bond line, read + EDIT its rest length / stiffness / bond attributes
│   │   ├── indicatorChartSettings.ts # Chart-settings merge/axis/tick helpers (gear popover)
│   │   ├── LightBallWidget.tsx       # 3D View: draggable "sun position" light-direction ball (SVG)
│   │   ├── recording/
│   │   │   ├── gifEncoder.ts         # GIF encode: identical-frame delay merge + transparent-index DELTA frames (chosen per frame by probing both ways)
│   │   │   ├── webmEncoder.ts        # Buffered WebM encode (GIF-fallback path) + the SHARED VP9 config (pickVp9Config / vp9EncoderConfig)
│   │   │   └── webmStreamEncoder.ts  # Streaming WebM: encode-as-you-go, only compressed bytes accumulate (queue-cap backpressure, drops)
│   │   ├── render/
│   │   │   └── gl3d.ts               # 3D Grid CA: WebGL2 voxel renderer (instanced cubes, orbit, clip, pick, lighting, cell gaps)
│   │   └── engine/
│   │       ├── SimEngine.ts          # Fallback engine (reference only)
│   │       ├── graphMetrics.ts       # GRA P6: graph-global metrics over the agent population (N/E/degree stats/histogram/components) — shared by the worker AND verify-graph-rewrite.mjs
│   │       ├── overseerRuntime.ts    # Overseer: main-thread experiment runtime (drives the worker via reqId-correlated messages; Journal + Series stores)
│   │       ├── sceneWireframe.ts     # The ONE 3D bounds/floor-grid/origin-axes line geometry + SCENE_MSAA_SAMPLES (the shared draw state) — used by the worker's voxel AND agent-sphere free-mode line passes and by gl3d
│   │       ├── traceProtocol.ts      # Rule Trace: the WORKER PROTOCOL — `TraceTarget`, `TraceCodes`, `traceCodesFromCompile` (the one index pairing of a periodic root's code to its `gridPeriodic:<id>` key), the `setTrace` / `requestTrace` / `clearTrace` messages and the `trace` / `traceBreak` / `traceTargetLost` / `traceCompileErrors` replies. DOM-free; compiler imports are `import type` only
│   │       ├── traceRunner.ts        # Rule Trace: the write-recording SANDBOX — every argument wrapped BY KIND (typed array → shadow proxy, identity-aliased; object → shallow copy; function → recording stub; `_rngState` → a private per-(element, generation) stream), methods DENY-by-default (`TraceSandboxEscape`), the event log + the read-back `writes`. DOM-free (the worker AND scripts/test-rule-trace.mjs import it)
│   │       └── sim.worker.ts         # Web Worker — owns grid (3D: total=W*H*D), runs steps. Also the RULE TRACE root registry, the three cadences, the breakpoint break path and `traceNbrRow`
│   ├── trace/                        # RULE TRACE — trace one cell's / one agent's rule through the graph, live (Live mode only)
│   │   ├── traceState.ts             # The trace STORE (main thread): the timeline ring of 40 + the session snapshot, on TWO notification channels (per-trace vs per-session, so the chip never re-renders per frame) + the memoised selectors every surface derives from. Pure state — it posts no worker message and compiles nothing
│   │   ├── traceOrigin.ts            # `originInScope` — THE ONE prefix rule mapping a resolved origin onto the editor's open macro scope (at root a record inside a macro lights the INSTANCE node; inside it, the inner node). DOM-free
│   │   ├── traceGraphMap.ts          # The EDITOR-side graph maths, DOM-free: edge/reroute origins (a value lights every segment and every dot with no per-trace path walk), value cones, the macro DEF index, the macro output map, the root id
│   │   ├── traceValues.ts            # The DOM-free half of the Trace panel: raw `writes` → the rows the Values tab shows (attributes, orientation, colour, glyph, neighbour writes, indicators, forces, requests, bond lanes, field deposits) + `formatNumber` / `formatNI` shared with the tooltip. NOTHING the trace wrote may be invisible — the `claimed` set is the enforcement
│   │   ├── TracePanel.tsx            # The bottom drawer of the graph pane: transport, timeline strip, Values / Steps / Breakpoints. `role="region"` (never dialog/menu), no button keeps focus on a mouse press, prefs under `genesisca_trace_panel`
│   │   ├── TracePanel.module.css
│   │   ├── TraceTooltip.tsx          # The hover surface: what this node / this wire carried, decoded by port type. Portalled to document.body, `position: fixed`, `pointer-events: none`, NO role
│   │   └── TraceTooltip.module.css
│   ├── dev/
│   │   └── compileHarness.ts        # DEV-only cross-target compile harness (byte-identity checks)
│   ├── help/
│   │   └── HelpView.tsx              # In-app comprehensive Help tab
│   ├── library/
│   │   └── ModelsLibrary.tsx         # Models Library tab (fetches from public/models/)
│   ├── model/
│   │   ├── ModelContext.tsx           # React Context + useReducer
│   │   ├── typeLabels.ts             # typeDisplayName(): 'bool'→Binary, 'float'→Decimal (UI-only names)
│   │   ├── thumbnail.ts              # Thumbnail media rules: accept list, size cap, isVideoThumbnail (WebM)
│   │   ├── spriteSheet.ts            # Sprite-sheet cell GEOMETRY (derived OR explicit) + the frame SELECTION (the ONE definition; decoder + dialog both derive from it)
│   │   ├── spriteCrop.ts             # Sprite CROP rect rules (resolve / clamp-for-editing / the whole-image FOLD) — the ONE definition; decoder + dialog + previews derive from it
│   │   ├── macroImport.ts            # cloneMacroWithFreshIds — ID regen for macro imports; countMacroInstances — THE model-wide instance walk (all 4 stores)
│   │   ├── macroReferences.ts        # M1: which MODEL ELEMENTS a macro's subgraph names (config values, ids embedded in KEYS + edge HANDLES, the transitive closure) → the `.gcamacro` `references` bundle
│   │   ├── defaultModel.ts           # EMPTY_MODEL (for New + the initial state on every app load)
│   │   ├── archetypes.ts             # C7 (P6): MODEL_ARCHETYPES + buildArchetypeModel — the New-model seeds (pure)
│   │   ├── agentCapabilities.ts      # Agent Capability Profiles: presets + dependency closure + node→capability table + usage-widened migration inference + footprint estimate (the single source of truth)
│   │   ├── fileOperations.ts         # .gcaproj save/load/download + .gcastate serialization
│   │   ├── agentTypeRemovalMigration.ts # Strips the removed built-in agent `type` from legacy files (setAgentType nodes, createAgent _port_type, behaviourStep myType edges); wired into LOAD_MODEL + macroImport + the dev harness
│   │   ├── schema.ts
│   │   └── types.ts                  # TypeScript types for CAModel (incl. CAModel.agentMappings — linked A→C views of the agent population)
│   ├── export/
│   │   └── exportPresentation.ts     # Presentation .html builder (fetch template + inject model + download)
│   └── viewer/                       # Standalone-.html viewer entry (mounts only SimulatorView)
│       ├── main.tsx                  # reads window model from <script id="genesis-model">, mounts ViewerApp
│       └── ViewerApp.tsx             # chromeless shell + About panel (R2) + Download-model (R1)
├── public/
│   ├── icon.svg                      # Two-cell app mark (source for the PWA + Tauri icon sets)
│   ├── pwa-*.png / maskable-icon-*.png / apple-touch-icon-*.png / favicon.ico  # Generated PWA icons
│   ├── models/                       # Library .gcaproj files (index.json auto-generated by Vite plugin)
│   └── macros/                       # Default .gcamacro files (index.json auto-generated by Vite plugin)
├── scripts/                          # Node-only generators + verification harnesses (never bundled)
│   ├── gen-cubic-gra.mjs             # the cubic triangle-split automaton — RETIRED from the shipped library (generator kept; regenerates public/models/Cubic GRA.gcaproj)
│   ├── gen-sdca.mjs                  # GRA flagship: Ilachinski-Halpern dual coupling + the hysteresis band
│   ├── gen-life-on-bonds.mjs         # GRA: Conway via the Neighbour Census over a bonded Moore ring (the O7 differential oracle)
│   ├── gen-graph-metrics-sweep.mjs   # GRA: the measurement half — six graph indicators + the Overseer sweep protocol
│   ├── gen-growing-graphs.mjs        # GRA: Cousin's binary cubic GRA, ported from znah's demo (topology AND physics)
│   ├── verify-graph-rewrite.mjs      # THE GRA harness: I1-I7 + oracles O3/O5/O6/O7/O8/O9/O11, 13 tiers, every check negative-controlled
│   ├── test-growing-graphs-physics.mjs # Growing Graphs LAYOUT parity: our real force pass vs a Node port of znah's force.js/main.c
│   ├── bench-spatial-index.mjs       # C11: shipped hash vs a per-radius hash vs an exact octree range query (+ --stats: every shipped model's radius/density)
│   ├── test-archetypes.mjs           # C7 (P6): the New-model seeds — Empty IS EMPTY_MODEL, per-card coherence, migration+resolution
│   ├── check-no-unseeded-random.mjs  # C7 (P7): no Math.random() on a simulation-semantic path (allowlist + stale-entry check)
│   ├── test-global-periodic.mjs      # Global Periodic Events: the two roots RUN — the grid fn over a real WASM module's memory (and the WASM step reads its write), the agent fn spawning through the real engine primitives (5 source-mutation negative controls)
│   ├── test-macro-references.mjs     # M1: macro reference collection + closure + the .gcamacro round trip (5 source-mutation negative controls)
│   ├── test-explicit-controls.mjs    # Explicit Controls: the schema/resolver/clone fix, the 3 control classes, groups, chaining, and that M1/M2/the clipboard need no new pass (8 source-mutation negative controls)
│   ├── test-sprite-sheet.mjs         # Sprite-sheet gridding: geometry, back-compat vs an independent legacy transcription, the selection, the decode signature
│   ├── test-sprite-crop.mjs          # Sprite CROP + COLORIZE: the rect rules by value, the per-frame sequence clamp, the fold, the decode signature (crop yes / colorize no), the multiply + 5-bit quantisation bound, the decoder ordering pins
│   ├── verify-handle-remeasure.mjs   # VPL editor: the port-signature remeasure is keyed on HANDLE ids (kind_category_portId), so a value ⇄ flow category flip re-measures (--self-test = negative control)
│   ├── test-rule-trace.mjs           # RULE TRACE, § A-K: origin coverage over every library model · a traced cell's writes == the real step · the recorded branch == the one the data selects · the sandbox is a reader (buffers hash-identical) · a traced agent's force == the real behaviour's · the runner (cap, escape, private RNG, shadow reads) · scope mapping · the editor graph maths · the Values rows · the P7b findings — every claim negative-controlled
│   └── verify-3d-depth-precision.mjs # 3D depth contract: agent radius spans >= 8 depth buckets at every zoom + the WebGPU near-clip margin (--old = negative control)
├── src-tauri/                        # Tauri v2 native-shell scaffold (Cargo.toml, tauri.conf.json, src/, icons/) — build needs Rust
├── docs/
│   ├── IMPACT_MAP_PWA_INSTALL.md     # PWA install + offline impact map (+ PLAN_PWA_INSTALL.md/.html)
│   ├── IMPACT_MAP_GRAPH_REWRITING_AGENTS.md  # GRA design authority (+ PLAN_ + HANDOFF_GRAPH_REWRITING_AGENTS.md and the per-phase HANDOFF_GRA_*.md)
│   ├── IMPACT_MAP_LIVE_SPLIT.md      # LIVE mode design authority (+ PLAN_LIVE_SPLIT.md/.html; origin BRAINSTORM_SEE_THROUGH_CANVAS.md/.html)
│   ├── PLAN_PANEL_ELEMENT_AFFORDANCE.md  # Panel element rows as grabbable objects (+ .html mockup, both themes)
│   └── NODES_REFERENCE.md            # Node catalogue + Mermaid diagrams + redundancy analysis
├── .github/
│   └── workflows/deploy.yml          # GitHub Pages deployment via GitHub Actions
```

---


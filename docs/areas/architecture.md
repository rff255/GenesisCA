# Architecture, model definition & settled decisions

> Area doc for **GenesisCA**. The six fundamentals, the model schema, the tech stack, the graph→compile strategy, the file formats, the presentation export, and the open investigations. Read when changing the model schema, adding a file format, or questioning a settled decision.
>
> **Also read** — a change here usually reaches [`project-structure.md`](project-structure.md) · [`compiler-core.md`](compiler-core.md) · [`engines-and-targets.md`](engines-and-targets.md) · [`io-and-formats.md`](io-and-formats.md).
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

- The GenesisCA Model Definition
- Architecture Decisions (Settled)
- Open investigations (brainstorms, no code) — social networks + neural networks / NCA (2026-09-05)

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
   - 1.1. Presentation (Name, Rule Author, GenesisCA Project Author, **Summary**, **Rule Description**, **Creation date**, Thumbnail, Tags...). `properties.createdDate?` (optional ISO `YYYY-MM-DD`) is the AUTHORED creation date behind the Models Library card stamp + its Newest/Oldest sort — see the "Model creation date" section. `properties.description` is the short **Summary** (UI label; the *only* presentation text shown on Models Library cards — internal id unchanged). `properties.ruleDescription?` (optional, additive — old files load without it) is the long-form **Rule Description** for elaborating at length on how the rule works; not shown on cards.
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

6. **Overseer (optional)** — a THIRD graph defining experiment orchestration AROUND the simulation: how executions are prepared, repeated, measured, and aggregated (replicate statistics, parameter sweeps, run-until-stop protocols, capture). Gated by `overseerConfig.enabled`; completely invisible when off. See the "Overseer (Experiment Orchestration)" major section.

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

**Approach: Compile the node graph at edit time to one of three ENGINES.** Chosen per model by the **Engine** radio in Properties → Execution — `Auto` (the default for new models) / WebAssembly / WebGPU, with **Debug (JS)** behind an Advanced reveal. See the "One Engine selector" section for the enum, the Auto policy and `resolveEngines`.

- **WebAssembly.** Hand-emitted WASM module, typically several times faster than JS on dense neighborhoods. Production engine for most models; exact + seedable (f64, one shared stream), bit-identical to the JS reference.
- **WebGPU.** WGSL compute shaders dispatched on the GPU. Best for very large grids and math-heavy per-cell work. Requires synchronous mode + a browser with WebGPU support.
- **Debug / Reference (JS).** Plain JavaScript via `new Function(...)`. The **semantic reference** the other two are verified against, the always-runnable fallback, and the source **Show Code always displays** (whatever engine runs) — but the slowest, so it is demoted behind Advanced rather than offered as a peer.

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

### Presentation Export (standalone `.html` — SHIPPED)

File ▾ → **Export standalone simulation…** bundles the Simulator + one model into a **single self-contained `.html`** that runs in any browser — no install, no server, offline from a bare `file://`. The web rewrite's replacement for legacy Genesis's `.exe` export. Docs: [docs/IMPACT_MAP_PRESENTATION_EXPORT.md](docs/IMPACT_MAP_PRESENTATION_EXPORT.md) / [PLAN_PRESENTATION_EXPORT.md](docs/PLAN_PRESENTATION_EXPORT.md) (+ `.html` mockup).

- **Why it needs no binary assets:** WASM bytes + WGSL are generated in-JS from the model graph at load (works under `file://`); the `.gcaproj` IS the graph (recompiled at load). So embedding the model JSON alone runs the sim. Sprites (`SpriteAsset.dataUrl`/frames), thumbnail, presets, and the initial board (`simulationState`) are all already base64 inside the `CAModel`, so **one file carries everything — no folder**.
- **The build-time viewer template + runtime injection design.** A SECOND Vite build (`vite build --mode viewer`, the `mode==='viewer'` branch in [vite.config.ts](vite.config.ts)) produces `viewer-template.html` — a fully-inlined single file (`vite-plugin-singlefile`) mounting ONLY `<SimulatorView>` under a viewer `ModelProvider` ([src/viewer/{index=viewer.html at repo root, main.tsx, ViewerApp.tsx}](src/viewer/main.tsx)), NO PWA/library plugins. The template reads its model from the `<script id="genesis-model" type="application/json">` placeholder. `build:viewer` copies it to `public/viewer-template.html` (served at `/viewer-template.html` in dev, copied into `dist/` by the main build → PWA-precached for offline). `npm run build` runs `build:viewer` first.
- **The worker seam (the single blocker, solved).** The sim worker is code-split (`new Worker(new URL('./engine/sim.worker.ts', import.meta.url))` → its own chunk), which a single-file inliner won't fold in. Extracted into [createSimWorker.ts](src/simulator/createSimWorker.ts) (main app: `new URL`) + [createSimWorker.inline.ts](src/simulator/createSimWorker.inline.ts) (viewer: `import W from './engine/sim.worker?worker&inline'` → base64 Blob worker). The viewer build swaps them via a `resolve.alias` (`/^\.\/createSimWorker$/`; anchor BOTH ends — a partial regex mangles the leading `./` into the absolute path). Verified: the inlined worker boots + instantiates WASM from in-memory bytes + steps under a single-file HTML.
- **Export flow** ([src/export/exportPresentation.ts](src/export/exportPresentation.ts) + [FileMenu.tsx](src/components/FileMenu.tsx) `doExport` + [ExportPresentationDialog.tsx](src/components/ExportPresentationDialog.tsx)): capture live state via the existing `genesis-capture-sim-state` event (same seam as Save; `include: {grid, controls}`) → `serializeModel(modelWithState)` → `fetchViewerTemplate()` (`${BASE_URL}viewer-template.html`) → `assemblePresentationHtml` injects the escaped JSON → `downloadHTML`. **Injection gotcha:** the placeholder sentinel `__GENESIS_MODEL_JSON__` appears TWICE in the built file (the `<script>` placeholder AND the bundled `EMBEDDED_MODEL_PLACEHOLDER` JS constant), so a bare string-replace hits the wrong one — target the `<script id="genesis-model">` element with a regex. Escape `<`→`<` (+ U+2028/9) so a `</script>`/`<!--` inside a string value can't break the tag. **Share previews:** `assemblePresentationHtml` also personalizes the `<title>`, injects og:/twitter: meta from the model's name/summary (+ the thumbnail as a data-URL og:image when ≤300 KB — most scrapers ignore data URLs, so hosted shares reliably show title+description only), and prepends a **human-readable HTML comment banner** right after the doctype (name / wrapped summary / authors / "open in a browser" / genesisca.online). The banner exists because messengers never OG-scrape file ATTACHMENTS — Discord/Slack preview an attachment's FIRST LINES as raw text (WhatsApp shows nothing for .html documents; unfixable), so those first lines must read as a title card, not minified code. Comment-safety: `commentSafe` replaces `--` runs with an en dash (a `-->` in a model name would terminate the banner). Verified incl. hostile names + the extractEmbeddedModel round-trip. The whole graph + sprites + metadata are ALWAYS embedded (they ARE the model); **grid / controls / PRESETS are the three opt-outs** (grid defaults OFF past 250k cells — a big base64 board dominates the file; **presets** default to the SAME derive rule Save uses — on iff the model HAS any — and their row is HIDDEN at zero, since the checkbox could not change the file either way). A presets opt-out is a real one: a presentation is usually ONE fixed configuration, and the recovered `.gcaproj` then carries none either. `doExport` strips them exactly the way `doSave` does (`{ ...model, presets: undefined }` — `stringifyCompact` drops undefined properties), so the shell of the exported HTML is byte-identical with the box on or off and only the embedded model JSON differs.
- **R1 — dual artifact (recoverable model source).** The `.html` embeds the COMPLETE `CAModel`, so the logic is never lost. The viewer's About panel has "⤓ Download model (.gcaproj)"; the IDE's Load accepts a presentation `.html` — `extractEmbeddedModel(html)` + the shared `parseModelJSON(text)` (the `readModelFile` body was refactored to expose both, [fileOperations.ts](src/model/fileOperations.ts)); `readModelFile` auto-detects HTML (extension / `<!doctype` / the `genesis-model` marker) and extracts first. FileMenu Load `accept` = `.gcaproj,.json,.html,.htm`. Verified round-trip: export → re-import → editable model recovered.
- **R2 — metadata display.** [ViewerApp.tsx](src/viewer/ViewerApp.tsx)'s About/Info panel (ⓘ, auto-open on first load) shows Title (`name`), Rule author (`author`), Project author (`modelAuthor`), Summary (`description`), Rule description (`ruleDescription`), Tags, Thumbnail — a lean read-only render (NOT coupled to the editing `InfoPanelContent`).
- **DEV helpers** (not shipped): [scripts/inject-test-model.mjs](scripts/inject-test-model.mjs) (inject a `.gcaproj` into the template for manual testing) + [scripts/static-serve.mjs](scripts/static-serve.mjs) (serve the single file — the Browser pane can't open `file://`, so verify over http; the runtime is identical). `dist-viewer/` + `public/viewer-template.html` are gitignored build artifacts.
- **WebGPU under `file://`** may not init (secure-context gating) — the worker falls back to JS/WASM automatically, so an exported WebGPU model runs on WASM; no COOP/COEP needed (non-shared `WebAssembly.Memory`).

---

## Open investigations (brainstorms, no code) — social networks + neural networks / NCA (2026-09-05)

Two research documents, each with an illustrated `.html` companion. **Nothing shipped**; they exist so a later Impact Map starts from something concrete. Both were verified against the current tree (the load-bearing codebase claims are marked `[verified]` inline).
- **[docs/INVESTIGATION_SOCIAL_NETWORKS.md](docs/INVESTIGATION_SOCIAL_NETWORKS.md)** — how SNA stores graphs (edge lists, node+edge CSV, GraphML, GEXF, GML, Pajek, DL, DOT, node-link / Cytoscape JSON — NetworkX's `links`→`edges` key flip in 3.6 is CONFIRMED, so an importer must accept both) and what GenesisCA lacks: **the file seam** (nothing in the app can create a bond from data — `pasteAgents` carries no bonds, `formBondBatch` no longer exists), generators, cheap graph measurements, and the ONE hard constraint — **`maxBonds` is a per-node degree cap on an ELLPACK store, so a scale-free hub sizes the whole store** (measured: BA 100k = 3.19 GB at `maxBonds` = max degree, 190× waste; the classic ≤10³-node corpus is comfortable). Recommends N1 = an agents+bonds importer riding an additive `bonds[]` member on `pasteAgents` (positional into `msg.agents`, so it also fixes the documented "pasted agents arrive unbonded"), N2 = generators in the importer + O(N+E) indicators + a worker-computed per-agent metric pass writing an agent attribute (**global metrics belong in the worker, not in a node**), and **keeps D2** (symmetric bonds) with a documented directed-edge attribute idiom (a `source` integer bond attribute; reciprocal arcs as a lo/hi pair). Betweenness/closeness are on-demand only (≈21 s / ≈6 s at 10k, measured).
- **[docs/INVESTIGATION_NEURAL_NETWORKS.md](docs/INVESTIGATION_NEURAL_NETWORKS.md)** — three shapes: **A** standalone networks as agents + bonds (Hopfield / spiking / SOM / reservoir — expressible TODAY, with Hebbian / Oja / STDP as `Set Bond Attribute` rules), **B** a shared per-cell MLP = a **Neural CA** (weights = **Lookup Tables** — a flat float array already live-updatable on all three targets via `updateLookupTable` and persisted in the `.gcaproj`; activations = Local Variable arrays), **C** per-agent brains as rows of a weight-bank table (`rowOffset = genomeId`). The Growing NCA architecture is verified from the Distill article (16 channels, fixed identity+Sobel perception → 48, dense 48→128 ReLU → 16 zero-init, ~8 000 params, p=0.5 mask, alpha>0.1 3×3 alive mask). **The gap is exactly one real emitter — `Dense Layer` (all six surfaces, accumulation order as the JS≡WASM contract) — plus three lowerings (`Gather` / `Pack` / `Unpack`) and a dependency-free weight importer (safetensors / npy / TF.js JSON → tables)**; with them the Growing NCA is a ~10-node graph and NCA-at-scale is a WebGPU feature (cost estimates in §4.7, deliberately labelled estimates). **Training**: gradients stay OUTSIDE in v1 (a framework dependency is ≈20/8/3 MB of WASM plus a fourth lockstep target — never); gradient-FREE training rides the Overseer (`ovRandomizeTable` exists; missing `ovPerturbTable` / `ovSnapshotTable` / `ovRestoreTable` / `ovCommitTable` + a loss indicator that is expressible today); a trained **DiffLogic CA** is a Boolean circuit = a `Logical Expression` graph (import as a generator, exact parity). Presets are checkpoints; Show Code prints the tables; the standalone `.html` export ships a trained NCA as one file.


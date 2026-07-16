# Impact Map — Presentation Export (standalone self-contained `.html`)

**Goal.** Export the Simulator + one compiled model as a **single self-contained `.html` file** that runs
in any modern browser with no server, no install, and no network. This is the web rewrite's replacement
for legacy Genesis's standalone `.exe` export (referenced in `CLAUDE.md` → "Presentation Export").

**Status before this work:** plan-phase only. `src/export/` contains one `.gitkeep`; no builder, no menu
entry, no schema. Everything below is design, grounded in the current source.

---

## The three enabling facts (why this is tractable)

1. **No external binary assets.** WASM bytes are generated entirely in-JS by the hand-rolled encoder
   (`src/modeler/vpl/compiler/wasm/`), instantiated from in-memory `Uint8Array` importing only
   `env.mem` + `Math.*` host funcs (`compile.ts:7614-7638`). WGSL is a runtime-generated string.
   **Nothing needs to be fetched at runtime** — the browser's own `WebAssembly`/WebGPU APIs suffice, and
   `WebAssembly.instantiate(bytes)` works fine under `file://`.
2. **The model file is the graph, not compiled code.** A `.gcaproj` is plain JSON of the whole `CAModel`
   (`graphNodes`/`graphEdges` + attrs/neighborhoods/mappings/…, `types.ts:1002-1057`). Code is
   **recompiled from the graph at load time** (`compileGraph`/`compileGraphWasm`/`compileGraphWebGPU` in
   `SimulatorView.tsx`). So embedding the model JSON alone is enough to run — no function-string to persist.
3. **The Simulator is coupled only to `ModelContext`.** `SimulatorView({visible})` takes no data props;
   it reads the live model via `useModel()` and auto-restores an embedded `model.simulationState`
   (`SimulatorView.tsx:3727-3743`). The whole runtime (worker + 3 compilers + agent engine + gl3d) is
   model-driven and self-contained; only the *component* is bound to the Modeler, through that one context.

4. **Everything the model needs is already base64-inlineable — so ONE file suffices, no folder.** Sprites are
   base64 data URLs (`SpriteAsset.dataUrl` + `frames[]`, `types.ts:274-305`), the thumbnail is a base64 data URL
   (`properties.thumbnail`, `types.ts:394-396`), presets carry their own embedded `SimulationState`, and the
   initial condition (`model.simulationState`) is base64 typed arrays. The entire `CAModel` — graph, properties,
   sprites, presets, initial state — serializes to one self-contained JSON. **The task's "maybe in a folder"
   concern is unnecessary: a single `.html` carries all attached assets.** (A folder would only ever be needed if
   an asset were an external URL; none are.)

## Two hard requirements from the task

- **R1 — the `.html` is a DUAL artifact: runnable AND a recoverable model source.** `window.__GENESIS_MODEL__`
  holds the COMPLETE `CAModel` (graphNodes/graphEdges + properties + attributes/neighborhoods/mappings/… +
  sprites/presets/simState), so the model's internal nodes/logic is never lost. This must be *recoverable*:
  (a) the viewer offers "Download model (.gcaproj)" + "Open in GenesisCA"; (b) the IDE's Load accepts a
  presentation `.html` and extracts the embedded model back into the editor.
- **R2 — all presentation metadata is displayed in the standalone sim.** Title (`properties.name`), Rule Author
  (`properties.author`), GenesisCA Project Author (`properties.modelAuthor`), Summary (`properties.description`),
  Rule Description (`properties.ruleDescription`), Tags (`properties.tags`), Thumbnail (`properties.thumbnail`).
  All are already serialized (they live on `properties`); the viewer must surface them in an About/Info panel.

## The one real blocker

**The Web Worker is code-split.** `new Worker(new URL('./engine/sim.worker.ts', import.meta.url),
{type:'module'})` (`SimulatorView.tsx:3446-3449`) emits a separate hashed chunk (`assets/sim.worker-*.js`).
A single-file HTML must inline it. Fix: build the viewer with Vite's `?worker&inline` suffix, which bundles
the worker's entire import graph and base64-embeds it as a classic Blob-URL worker (browser-compatible under
`file://`). This is the central architectural work item.

---

## Chosen approach — "build-time viewer template + runtime injection"

- Add a **second, tiny Vite build** producing a **fully-inlined viewer template HTML** (`vite-plugin-singlefile`
  + `?worker&inline`). The template mounts ONLY `<SimulatorView/>` under a viewer `ModelProvider`; it excludes
  React Flow, the Modeler, the library, and the navbar. It reads its model from a global placeholder
  (`window.__GENESIS_MODEL__`).
- At **export time in the running app**, fetch that template, inject the serialized model (with an optional
  embedded live-grid `simulationState`) into the placeholder, and download the result. No hashed-chunk
  stitching in the running app.

Rationale vs. alternatives:
- *In-browser bundling of the running app's own chunks* — fragile (hashed names, dynamic imports), rejected.
- *`?raw`-import the template into the main bundle* (offline without precache) — viable, but forces a
  two-pass build (viewer must build before main). Kept as a documented alternative; default is fetch+precache.

---

## Subsystem-by-subsystem impact

### 1. Build tooling — `vite.config.ts`, `package.json`  — **NEW config, HIGH effort**
- Today: single implicit `index.html` entry, no `rollupOptions.input`, no single-file plugin
  (`vite.config.ts:196-277`; `package.json:23-34`).
- Add `vite-plugin-singlefile` (devDep). Add a **viewer build mode** — a separate config branch keyed on an
  env flag (e.g. `VIEWER=1`) that: uses `viewer/index.html` as the root/entry, enables singlefile, **disables**
  `modelsLibraryPlugin`/`macrosLibraryPlugin`/`VitePWA` (a viewer needs none and must NOT register a SW),
  and outputs to a known path (`dist-viewer/viewer-template.html`, copied to `public/` or `dist/`).
- New scripts: `build:viewer` (the template) + wire it into `build` so `npm run build` produces both.
- **Risk:** singlefile + a `type:module` worker. Mitigation: `?worker&inline` (emits a classic Blob worker,
  no bare imports remain after Vite bundles the worker graph). Must be verified in a real browser under `file://`.

### 2. Worker instantiation seam — `SimulatorView.tsx` (+ a tiny factory) — **LOW/MED effort**
- Extract worker creation into `createSimWorker()` (one small module) so the viewer build can resolve it to a
  `?worker&inline` variant while the main app keeps `new URL(...)` (avoids bloating the main bundle with an
  eagerly-parsed base64 worker string). Resolve via a Vite `resolve.alias` under the viewer flag, or a
  `import.meta.env`-gated branch.
- Everything else in SimulatorView is reused verbatim.

### 3. New viewer entry — `src/viewer/{index.html, main.tsx, ViewerApp.tsx}` — **MED effort**
- `viewer/index.html`: minimal shell (root div, theme-init script, the `window.__GENESIS_MODEL__` placeholder
  `<script id="genesis-model">`), NO PWA/manifest links.
- `main.tsx`: `createRoot(...).render(<ModelProvider><ViewerApp/></ModelProvider>)`; on mount parse
  `window.__GENESIS_MODEL__`, run it through the same `readModelFile` normalization (BOM/undefined-recovery +
  NI migration + schema guard, `fileOperations.ts:248-339`) or `loadModel(parsed)`, then render `<SimulatorView
  visible/>`. Embedded `simulationState` auto-restores (`SimulatorView.tsx:3727-3743`).
- `ViewerApp`: a chromeless shell (theme applied; the canvas + SimulatorView's own transport/overlays). No
  FileMenu, no mode switch, no library. Adds **(R2)** an **About/Info panel** (toggle from an ⓘ button, and shown
  on first open) rendering `properties.name` / `author` (Rule Author) / `modelAuthor` (Project Author) /
  `description` (Summary) / `ruleDescription` / `tags` / `thumbnail` — reuse the read-only rendering from
  `InfoPanelContent.tsx` rather than re-authoring it. Adds **(R1)** a "⤓ Download model (.gcaproj)" button (writes
  `serializeModel(model)` — the embedded `CAModel` is already complete) and an "Open in GenesisCA" link
  (deep-links to the app, or just instructs "load this .html in GenesisCA").

### 4. `ModelContext` — **LOW effort (mostly reuse)**
- Keep the full in-memory `ModelProvider` — this makes the viewer genuinely interactive (play/step/brush,
  model-attribute sliders live-tune, viewer-tab switching, in-memory presets, recording/screenshot) for free.
- Editing actions SimulatorView calls (preset CRUD, `updateProperties`, `updateAttribute`, `setSimulationState`)
  remain functional in-memory and harmless (no file IO exists in the viewer). No new context needed; possibly a
  `readOnly`/`isViewer` flag later if we want to hide preset-authoring affordances (nice-to-have, not required).

### 5. Export assembly — `src/export/exportPresentation.ts` (NEW) — **MED effort**
- `exportPresentation(model, opts)`: (a) optionally capture the live grid via the existing `getState`
  round-trip (same seam as "Save Project → include grid", `genesis-capture-sim-state` CustomEvent) → embed as
  `simulationState` via `serializeSimState` (`fileOperations.ts:428-521`); (b) `serializeModel(modelWithState)`
  (`:196`); (c) fetch `${BASE_URL}viewer-template.html`; (d) inject the JSON into the placeholder script
  (escape `</script>`/U+2028/U+2029); (e) download via `saveTextFile` (`:216-246`, Tauri dialog vs blob).
- Reuses existing serializers wholesale — no new file format.

### 6. UI — `src/components/FileMenu.tsx` (+ an options dialog) — **MED effort**
- Add "Export Presentation…" to the File menu. Dialog options: title/credits (default from `properties`),
  **include current grid state** (reuse the save-dialog include.grid/controls semantics), starting viewer
  (A→C mapping), and interactivity toggles (autoplay on open? show transport?). Behavior/UI change → **requires
  the illustrated HTML mockup** (see `PLAN_PRESENTATION_EXPORT.html`).

### 6b. Model recovery from `.html` — `fileOperations.ts` + `FileMenu.tsx` — **LOW effort (R1)**
- The IDE's Load path (`readModelFile`, `fileOperations.ts:248-339`) accepts a presentation `.html`: detect an
  HTML input (or a `.html` extension), extract the `#genesis-model` script's JSON (regex/DOM-parse the
  `window.__GENESIS_MODEL__` placeholder), then run the SAME normalization it already does for `.gcaproj`
  (BOM/undefined-recovery, NI migration, schema guard). So dropping an exported `.html` back into GenesisCA
  recovers the full editable model — the logic is never trapped inside the artifact.
- `FileMenu.tsx` file-input `accept` gains `.html`; the extractor is a small shared helper (also used by the
  viewer's "Download model" and by any future `.gcaproj`-from-`.html` tooling).

### 7. Offline / PWA — `vite.config.ts` PWA globPatterns — **LOW effort**
- If the template is fetched at runtime, add `viewer-template.html` to `VitePWA` `globPatterns` so export works
  offline. (Not needed for the `?raw`-import alternative.)
- The **viewer template itself must NOT register a service worker** (App.tsx's SW-register is web-only and keyed
  on `!('__TAURI_INTERNALS__' in window)`; the viewer entry simply never calls `registerSW`).

### 8. Docs — **LOW effort**
- `CLAUDE.md` (flip "Presentation Export" from planned → shipped + a section), `src/help/HelpView.tsx`, `README.md`.
  NODES_REFERENCE unaffected (no nodes).

---

## Cross-cutting risks & gotchas

- **Worker module-blob compat (highest risk).** `?worker&inline` must produce a worker that instantiates under
  `file://` across Chrome/Firefox/Safari. Verify early with a throwaway inline-worker build before committing to
  the full viewer.
- **WebGPU under `file://`.** Some browsers gate WebGPU/OffscreenCanvas-transfer on secure contexts; `file://` may
  not qualify. The worker already **falls back to JS/WASM** automatically, so this is graceful — but document that
  an exported WebGPU model runs on WASM when opened from a bare file. (WASM from in-memory bytes is fine under `file://`.)
- **No SharedArrayBuffer / COOP-COEP dependency.** The engine uses a non-shared `WebAssembly.Memory` + typed
  arrays, so no cross-origin-isolation headers are required (which `file://` couldn't provide anyway). Confirmed
  from the instantiation path (`compile.ts:7614-7638`).
- **File size.** Template (inlined runtime JS, ballpark ~1–2 MB uncompressed) + model JSON. Embedded grid state is
  base64 typed arrays and can dominate (e.g. Elementary CA 1D's shipped state ≈ 10.8 MB). The "include grid state"
  toggle governs this; default OFF for large grids, and warn past a threshold. Definition-only export is small.
- **`</script>` / line-separator injection.** The model JSON is injected into an HTML `<script>`; escape `</script`,
  U+2028, U+2029, and `<` to avoid breaking the tag or JSON parse.
- **Template staleness.** The template is a build artifact — it must be rebuilt whenever the runtime changes.
  `npm run build` must produce it (CI covers it for free). A stale template silently exports old runtime behavior;
  gate on a version stamp so a mismatch is visible.
- **Theme.** The viewer should honor `properties`-driven or embedded theme; the boot theme-init script must be
  self-contained (no localStorage dependency for a first-open on a stranger's machine — default to Nocturne).
- **Tauri.** In the desktop shell the same export writes via the native Save-As path (`saveTextFile` already
  branches on `__TAURI_INTERNALS__`). The exported file itself is a plain browser artifact regardless.

---

## Verification strategy (per the 2D/3D × 3-target discipline)

- Export a **2D JS** model (Game of Life), a **2D WASM** model (default), a **2D WebGPU** model, a **3D** model
  (Life3D), and an **agents** model (Boids). Open each exported `.html` from `file://` in a fresh browser profile
  and confirm: it loads, plays, brushes, switches viewers, and — for the WebGPU export — falls back cleanly.
- Confirm **no network requests** after load (offline true-test: disconnect, open the file).
- Confirm the injected `simulationState` restores (a saved-with-grid export opens on the exact saved board).
- Confirm the running app's export flow works **offline** (template precached) in the PWA.

---

## Out of scope (v1)

- A hosted/shareable-link export (this is a local file only).
- Embedding the Modeler/editing in the viewer (viewer is run-only + interactive controls).
- Multi-model "gallery" exports.
- Shrinking the runtime bundle via per-model dead-code elimination (e.g. dropping the WebGPU compiler when a model
  is JS/WASM-only) — a possible size optimization, deferred.

# Plan — Presentation Export (standalone self-contained `.html`)

Implements the design in [`IMPACT_MAP_PRESENTATION_EXPORT.md`](IMPACT_MAP_PRESENTATION_EXPORT.md). Illustrated
mockup: [`PLAN_PRESENTATION_EXPORT.html`](PLAN_PRESENTATION_EXPORT.html).

**One-line summary.** A build-produced, fully-inlined **viewer template HTML** (Simulator only, worker inlined,
no PWA/library) reads its model from a `window.__GENESIS_MODEL__` placeholder; the running app exports by
fetching that template, injecting a serialized model (+ optional live grid state), and downloading **one
self-contained file** that carries the complete model — graph, properties, sprites, presets, initial state — all
already base64 (no folder needed).

**Two task requirements woven through the PRs:**
- **R1 — dual artifact.** The `.html` embeds the whole `CAModel`, so the model/logic is never lost: the viewer can
  re-download the `.gcaproj`, and the IDE's Load accepts the `.html` to recover the editable model.
- **R2 — metadata on display.** The standalone sim shows Title / Rule Author / Project Author / Summary / Rule
  Description / Tags / Thumbnail in an About panel.

---

## PR0 — Spike: prove the inlined worker runs under `file://` (½ day, throwaway)

The single highest risk is the inlined `type:module` worker. De-risk it before building anything real.

1. Temporary branch: import the sim worker with `?worker&inline`, add `vite-plugin-singlefile`, build a
   throwaway single-file page that just instantiates the worker and posts a trivial `init`/`step`.
2. Open the built HTML from `file://` in Chrome, Firefox, and Safari (or WebView2). Confirm the worker boots,
   the WASM instantiates from in-memory bytes, and a step round-trips.
3. If module-blob workers misbehave in a target browser, fall back to `worker.format: 'iife'` for the viewer
   build (classic worker) — the worker code has no top-level `await`/module-only features that block this
   (verify `sim.worker.ts` header).

**Exit criterion:** a single `.html` with an inlined worker runs a step offline in all target browsers.
Nothing downstream is worth building until this holds.

---

## PR1 — The viewer app + template build (core)

**New files**
- `src/viewer/index.html` — minimal shell: `<div id="root">`, self-contained theme-init inline script
  (default Nocturne, no localStorage requirement), and `<script id="genesis-model" type="application/json">
  /*__GENESIS_MODEL__*/</script>` placeholder. NO manifest/PWA links.
- `src/viewer/main.tsx` — parse `#genesis-model` JSON → normalize via the `readModelFile` code path (reuse the
  BOM/undefined-recovery + NI migration + schema guard) → `createRoot(...).render(<ModelProvider><ViewerApp
  model={parsed}/></ModelProvider>)`. On mount, `loadModel(parsed)`.
- `src/viewer/ViewerApp.tsx` — chromeless shell: apply theme; render `<SimulatorView visible/>`. No
  FileMenu/mode-switch/library. Plus:
  - **(R2) About/Info panel** — an ⓘ toggle (auto-shown on first open) rendering Title (`properties.name`),
    Rule Author (`properties.author`), Project Author (`properties.modelAuthor`), Summary
    (`properties.description`), Rule Description (`properties.ruleDescription`), Tags (`properties.tags`),
    Thumbnail (`properties.thumbnail`). **Reuse `InfoPanelContent.tsx`'s read-only rendering** (extract a small
    presentational component if needed) so it can't drift from the Modeler's Info tab.
  - **(R1) "⤓ Download model (.gcaproj)"** — `saveTextFile(serializeModel(model), name+'.gcaproj')`; the embedded
    `CAModel` is already complete. Plus an "Open in GenesisCA" hint (the same `.html` loads back into the IDE).
- `src/simulator/createSimWorker.ts` — `export const createSimWorker = () => new Worker(new URL('./engine/
  sim.worker.ts', import.meta.url), {type:'module'})`. SimulatorView calls this instead of inlining the
  constructor. The **viewer build** aliases this module to a `?worker&inline` variant.

**Edits**
- `SimulatorView.tsx:3446` → `createSimWorker()`.
- `vite.config.ts`: a `VIEWER` env branch — root = `src/viewer`, plugins = `[react(), singleFile()]`
  (no models/macros/PWA), `resolve.alias` swapping `createSimWorker` for the inline variant,
  `build.outDir = 'dist-viewer'`, emit `viewer-template.html`. Main build unchanged.
- `package.json`: `"build:viewer": "vite build --mode viewer"` (or `cross-env VIEWER=1 vite build`); make
  `"build"` run both and copy `dist-viewer/viewer-template.html` → `dist/viewer-template.html`.
- devDep: `vite-plugin-singlefile`.

**Verify (PR1 done = a hand-built export runs):** temporarily inject a real `.gcaproj` (e.g. Game of Life) into
the built template by hand, open from `file://`, confirm it plays. Do this for a JS, a WASM, a 3D, and an agents
model. Confirm zero network requests post-load.

---

## PR2 — Export flow + UI (the user-facing feature)

**New files**
- `src/export/exportPresentation.ts`:
  - `exportPresentation(model, opts): Promise<boolean>` —
    1. If `opts.includeGrid`/`includeControls`: capture live state via the existing `genesis-capture-sim-state`
       CustomEvent seam (SimulatorView resolves it via a worker `getState`), then `serializeSimState(...)` →
       set `model.simulationState`.
    2. `serializeModel(model)` (reuse `fileOperations.ts:196`).
    3. `fetch(`${import.meta.env.BASE_URL}viewer-template.html`)` → text.
    4. Inject the JSON into the `#genesis-model` placeholder, **escaped** for `</script`, `<`, U+2028, U+2029.
    5. Stamp a runtime-version marker (compare on viewer boot; warn on mismatch).
    6. `saveTextFile(html, `${name}.html`)` (reuse `fileOperations.ts:216`, Tauri/browser aware).
  - A size guard: if the assembled HTML exceeds a threshold (grid state dominates), warn before download.

**Edits**
- **(R1) IDE re-import of `.html`** — `fileOperations.ts`: a shared `extractEmbeddedModel(htmlText)` helper
  (pulls the `#genesis-model` JSON out of a presentation `.html`); `readModelFile` detects an HTML input and
  routes through it, then runs the existing `.gcaproj` normalization (BOM/undefined-recovery + NI migration +
  schema guard). `FileMenu.tsx` Load `accept` gains `.html`. Net: dropping an exported `.html` back into GenesisCA
  recovers the full editable model.
- `FileMenu.tsx`: add "Export Presentation…" → opens `ExportPresentationDialog`.
- `src/components/ExportPresentationDialog.tsx` (NEW, reuse `SaveProjectDialog.module.css`): title/credits
  (default from `properties`), **Include current board state** + **Include simulator controls** (mirror the save
  dialog's `deriveSaveOptions` semantics), **Starting viewer** (A→C mapping dropdown), **Autoplay on open**
  (bool), **Show transport controls** (bool). On confirm → `exportPresentation`.
- Thread the two viewer-behavior options (autoplay, show-transport) into the exported model — store them under a
  small additive `model.properties.presentation?: { autoplay?, showTransport?, startingViewer? }` (schema-additive,
  ignored by the Modeler) that `ViewerApp` reads.

**Verify (PR2 done):** from the running app, export each of the 5 test models via the dialog; open each `.html`
offline; confirm options honored (autoplay, starting viewer, grid state restored). **R2:** the About panel shows
every metadata field (incl. a model WITH a thumbnail + tags + long Rule Description). **R1 round-trip:** in the
viewer, "Download model" yields a `.gcaproj` that re-loads identically; loading the exported **`.html` back into
GenesisCA** recovers the full editable graph. **Sprites/presets** survive: export an agents+sprites model and a
model with presets, confirm both render/apply in the standalone file (one HTML, no folder). Confirm the app-side
export works offline in the installed PWA (template precached — see PR3).

---

## PR3 — Offline, size, polish, docs

- `vite.config.ts` PWA `globPatterns`: add `viewer-template.html` so the running PWA can export offline.
- Size handling: default **Include board state = OFF** when the grid product exceeds a threshold; show the
  estimated exported size in the dialog; warn past ~15 MB.
- Version-stamp mismatch UX: if a fetched template predates the current app (stale precache), surface a small
  "regenerating…" revalidation rather than silently exporting old runtime.
- Docs sweep (atomic): `CLAUDE.md` (Presentation Export planned→shipped + a subsystem section), `HelpView.tsx`
  (a "Share as a standalone page" entry), `README.md`.
- **No version bump.** Versioning is the user's call — never bump as part of finishing a feature. When the user
  decides to cut a release they run the `/updateversion` skill themselves.

---

## Decisions (settled)

1. **Template delivery** — ✅ **Fetch a shipped `viewer-template.html` (precached for offline).** Two independent
   builds, simplest build order; add the file to the PWA `globPatterns` (PR3) so app-side export works offline.
   The `?raw`-import-into-the-main-bundle alternative is rejected (two-pass build + ~1–2 MB main-bundle bloat).
2. **Viewer interactivity level** — ✅ **Fully interactive** (play/step/brush/model-attribute sliders/record,
   in-memory presets). Achieved for free by mounting the full in-memory `ModelProvider`; no `readOnly` shim needed
   in v1. The dialog's "Show transport controls" toggle governs presentation chrome only, not capability.
3. **Worker inline mode** — decided empirically in PR0: `?worker&inline` (module) if it runs everywhere, else
   `worker.format:'iife'` (classic) for the viewer build.

---

## Effort estimate

| PR | Scope | Effort |
|----|-------|--------|
| PR0 | Inlined-worker spike (throwaway) | ½ day |
| PR1 | Viewer app + template build | 2–3 days |
| PR2 | Export flow + dialog + FileMenu | 2 days |
| PR3 | Offline/size/docs | 1 day |

Total ≈ 1 working week, gated on PR0.

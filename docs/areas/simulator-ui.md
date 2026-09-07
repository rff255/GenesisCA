# Simulator UI — canvas, transport, capture, panels

> Area doc for **GenesisCA**. SimulatorView: rendering, the transport bar, capture (screenshot/recording), the cursor overlay, panel layout and resize.
>
> **Also read** — a change here usually reaches [`simulation-engine.md`](simulation-engine.md) · [`agent-render.md`](agent-render.md) · [`agent-brush-ui.md`](agent-brush-ui.md) · [`grid-3d.md`](grid-3d.md) · [`io-and-formats.md`](io-and-formats.md) · and, since **Live** mode puts this view beside the graph editor in one workspace, [`modeler-ui.md`](modeler-ui.md).
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

- UX/feature batch (branch `tasks_batch_2026_07`, off `polish_agents`)
- 3D auto-zoom (the dolly sibling of auto-orbit)
- Quick-wins batch (branch `improvements`, 2026-07-27)
- Medium-features batch (branch `improvements`, 2026-07-28 — five features, one commit each)
- Panel resize responsiveness: the canvas re-sizes DURING the drag (2026-08-05)
- LIVE mode — the simulator inside the split workspace (Phase 2, 2026-09-07)
- LIVE mode — the edit→rule PIPELINE (Phase 3, 2026-09-07)
- LIVE mode — INPUT OWNERSHIP and the perf guards (Phase 4, 2026-09-07)

---

## UX/feature batch (branch `tasks_batch_2026_07`, off `polish_agents`)

A batch of general + agent + CA-grid improvements. All additive/gated; the lattice (2D+3D, all 3 targets) + every non-touched model are byte-identical. Verify with `npm run build` (tsc -b + vite).

### Presets — reorder (simulator)
Simulator presets (`CAModel.presets`) are drag-to-reorderable via a `⋮⋮` handle, mirroring the attribute/neighborhood/indicator reorder UX. `REORDER_PRESETS` reducer (clone of `REORDER_INDICATORS`, reuses `reorderById`) + `reorderPresets` context callback; [SimulatorView.tsx](src/simulator/SimulatorView.tsx) wires `useListReorder(model.presets, reorderPresets)` into the Presets block; the four reorder CSS classes were copied into [SimulatorView.module.css](src/simulator/SimulatorView.module.css). **Order round-trips in `.gcaproj` for free** (array order via `stringifyCompact`; no fileOperations change). Presets persist ONLY via explicit `.gcaproj` save gated by the SaveProjectDialog "Include model presets" checkbox — there is NO active model autosave (the older CLAUDE.md note about presets being "stripped from localStorage autosave" was stale; `ModelContext` only one-shot removes a legacy `genesisca_autosave` key).

### Duplicate buttons (attributes / variables / mappings / indicators / presets, cell + agent)
`DUPLICATE_*` reducers + callbacks for `DUPLICATE_ATTRIBUTE` / `DUPLICATE_AGENT_ATTRIBUTE` / `DUPLICATE_MAPPING` / `DUPLICATE_AGENT_MAPPING` / `DUPLICATE_VARIABLE`(target cell|agent) / **`DUPLICATE_INDICATOR`** / **`DUPLICATE_PRESET`**, mirroring `DUPLICATE_NEIGHBORHOOD`. Each deep-clones the source via `JSON.parse(JSON.stringify(...))` (the graphHistory.ts convention) with a fresh `generateId()` + " (copy)" name and **APPENDS** (so the panels' list-grew auto-select lands on the copy). A sub-attribute copy keeps its `parentAttributeId`; a linked mapping/variable/indicator keeps its attribute reference; a **preset** copy also gets a fresh `createdAt` and deep-clones its embedded `SimulationState` (grid snapshot). UI "Duplicate" buttons: [AttributesPanelContent.tsx](src/modeler/panels/AttributesPanelContent.tsx) (cell/agent + model button rows; `handleDuplicate` routes on `selectedIsAgent`), [VariablesPanelSection.tsx](src/modeler/panels/VariablesPanelSection.tsx), [MappingsPanelContent.tsx](src/modeler/panels/MappingsPanelContent.tsx) (A→C, C→A, + an inline Duplicate per agent view), **[IndicatorsPanelSection.tsx](src/modeler/panels/IndicatorsPanelSection.tsx)** (a `buttonRow` Duplicate, disabled until an indicator is selected — Properties → Indicators), and **[SimulatorView.tsx](src/simulator/SimulatorView.tsx)** (a `⧉` icon button per preset row in the simulator Presets list). **Standalone-mapping/indicator duplicate is DEFINITION-ONLY** — a LINKED mapping/indicator's copy regenerates its colour pass / aggregates immediately, but a hand-built standalone mapping's copy (and a standalone indicator's copy) has no graph nodes pointing at its new id (renders an empty pass / stays unwired until the user wires it); this matches the "duplicate the definition" scope of the neighborhood duplicate.

### Indicators — Clear chart + selectable time-axis Window
- **Clear button** (`⌫` in each indicator's header, for scalar + freq charts): `onClearHistory(id)` → SimulatorView `clearIndicatorHistory` deletes `indicatorHistoryRef.current[id]` and bumps a `useReducer` counter (`bumpIndicatorRender`) so the display repaints the now-empty history even while PAUSED (history is a ref, no auto re-render).
- **Window** = `IndicatorChartSettings.window` (number of most-recent generations shown on the time X-axis). TWO layers like the colour/axis settings: model DEFAULT (the Indicators panel's `ChartDefaultsEditor`) + simulator OVERRIDE (the ⚙ gear popover), merged in `mergeChartSettings`. [indicatorChartSettings.ts](src/simulator/indicatorChartSettings.ts) adds `historyWindow(s)` (clamp ≥2, ≤`INDICATOR_HISTORY_HARD_CAP`=5000) + `sliceWindow`. [IndicatorDisplay.tsx](src/simulator/IndicatorDisplay.tsx) slices the scalar sparkline + freq multiline/stacked data to the window before drawing (the charts derive `genStart` from the visible length, so X-axis labels stay correct); **spatial (rows/cols/layers) charts are EXCLUDED** (position-binned, no time-history). SimulatorView keeps an adaptive `indicatorHistoryCapRef` = max(500, largest configured window) so a window >500 truly shows that many generations (the two collection-loop `500` caps now read the ref).
- **"All" (blank window) is ALWAYS BOUNDED — no unbounded growth.** Stored history is trimmed EVERY step (the `.shift()` at the two collection sites) to `indicatorHistoryCapRef.current` = `max(INDICATOR_HISTORY_DEFAULT_CAP=500, largest configured window)`, and `historyWindow` clamps ANY configured window to `≤ INDICATOR_HISTORY_HARD_CAP=5000`. So the per-series sample count can never exceed 5000 (500 by default when every indicator is on "all"); blank/"all" = *show all stored history*, itself capped. THREE layers enforce the ceiling: the `NumberField max={INDICATOR_HISTORY_HARD_CAP}` blur-clamp (both editors), `historyWindow`'s `Math.min(n, 5000)` at read time, and the unconditional collection `.shift()`. The window field tooltips say so explicitly ("Blank = show all stored history (always bounded: history is capped at 5000 samples per series)"). No "very large limit" (999999999) is needed — 5000 IS the hard guarantee.

### Recording — agents/3D "stale trails" fix (`forceFrameOpaque`) + the OPAQUE CAPTURE BACKDROP
GIF (and defensively WebM) recordings of transparent-background content (2D agents-only cleared to transparent black; 3D's transparent GL clear when no environment background is set) accumulated **stale trails** as the camera orbited / an agent moved — the classic GIF frame-disposal-over-transparency bug. Fix: `forceFrameOpaque(data)` sets every captured frame's alpha to 255, and it **MUST STAY** — it is the one guarantee the GIF encoder's delta/disposal logic rests on. Both captured buffers are fresh copies (safe to mutate). Screenshots (PNG, single-frame) keep their alpha and are untouched.
- **⚠ THE PREMISE IT RESTED ON WAS ONLY TRUE FOR OPAQUE CONTENT, AND THE GLOW BROKE IT** (user-reported 2026-08-15: *"recordings of agent models with Glow on come out super saturated / high contrast"*). The claim was *"the RGB already equals the straight-alpha composite over black"*. **It does not on a 2D canvas: `getImageData` returns UN-PREMULTIPLIED RGB**, so a partial-alpha pixel reads back as its FULL-STRENGTH hue paired with a small alpha — and forcing alpha to 255 then displays that hue at full opacity. For opaque discs over a transparent clear that was harmless (only the ~1 px antialiased rim was affected). The agent **glow halo is a whole FIELD of partial-alpha pixels** (the CPU overlay encodes the tonemapped magnitude in ALPHA; the GPU direct-render canvas is `alphaMode: 'premultiplied'`), so a faint halo recorded as a hard-edged, fully-saturated blob. **Measured on Particle Life** (same frozen state, same renderer): the recorded frame had mean max-channel **218.3** with **21.4 % of lit pixels clipped (≥250)**, against **69.2 / 0 %** for the identical frame composited correctly; the radial profile of an isolated agent read `230,230,…,230,255,255,0` — flat full hue then a cliff — instead of a falloff.
- **THE FIX IS IN CANVAS SPACE, NOT A PIXEL LOOP: fill the 2D capture target with `CAPTURE_BACKDROP` BEFORE drawing the frame content**, so the browser does the premultiplied composite and the readback is already correct. Two sites, both recording-only: the view-scope `recordScratchRef` (an opaque `fillRect` REPLACES its `clearRect`, then the display draws source-over) and `renderSimulationFrame`'s new trailing **`opaqueBackdrop`** parameter. `forceFrameOpaque` then becomes a belt-and-braces no-op on 2D.
- **`CAPTURE_BACKDROP` is BLACK, deliberately** — it is exactly the composite the old comment claimed, so a fully-transparent region (the letterbox margins) still records as pure black and an opaque region is untouched; only the partial-alpha pixels move. Both shipped themes' canvas backdrop is near-black (`#08090b` / `#1d1d1d`), so it also matches what the user sees. (A `bg2d` environment background is drawn ON TOP of it by the existing paths, unchanged.)
- **3D IS DELIBERATELY UNTOUCHED, and the premise there was VERIFIED not assumed**: recording forces UI-sync ON ⇒ frame mode ⇒ the 3D capture is a raw `readPixels` on a `premultipliedAlpha: true` drawing buffer, i.e. bytes that are ALREADY the composite over black — re-applying alpha would double-darken. Measured on Particle Life 3D: of 115 546 lit pixels, **88 285 carry partial alpha and ZERO have RGB > alpha** (the premultiplied signature; un-premultiplied data would violate that in tens of thousands of pixels).
- **SCREENSHOTS ARE DELIBERATELY UNCHANGED and still transparent.** A PNG stores un-premultiplied alpha and every viewer composites it correctly, so a transparent-background screenshot of a glow model is right as it is — and it is what makes a screenshot usable over a light backdrop. `renderSimulationFrame`'s screenshot call passes `opaqueBackdrop = false`; the view-scope screenshot never went through the scratch at all.
- **Verified through the real UI, by pixels.** *Simulation scope, Particle Life (GPU direct render):* recorded GIF frame mean max-channel **218.3 → 72.5**, saturated pixels **21.38 % → 0**, against a ground truth of **69.1 / 0 %** taken from the screenshot path (same renderer, same state, composited over black) with p10/p50 **identical at 7 / 58**; on a frozen 5-agent deterministic scene the isolated agent's radial profile went from flat-then-cliff to a smooth **136 → 96 → 81 → 60 → 39 → 28 → 15 → 0** with the lit-pixel footprint **unchanged (2780 both)**. *View scope, Morphogenesis — Growing Tissue (CPU overlay):* the real recorded frame is **bit-identical to the display canvas composited over black — 0 of 502 016 pixels differ, maxΔ 0**; running the OLD recipe on that same source canvas differs from the correct composite in **3 414 pixels, mean Δ 147.9, max Δ 254**. *WebM:* the exact RGBA buffer handed to `new VideoFrame(…)` (912², intercepted at the encoder boundary) reads **72.4 mean / 0 saturated / alpha 255 everywhere** — the same corrected pixels, as it must be (both formats share `acceptRecordedFrame`). *Stale-trails invariant:* every captured frame on every path still has alpha 255 everywhere.
- **GLOW-OFF IS NOT BYTE-IDENTICAL, and the delta is named**: on a frozen deterministic scene, **830 887 pixels stay exactly black and 603 stay exactly the flat agent colour — only 254 (0.031 % of the frame) change**, and they are the 1-px antialiased disc rim, which now composites correctly (e.g. `231,68,68 → 58,17,17`) instead of recording at full hue. Interiors, background and the lit footprint are unchanged. That is a correction of the same class of bug, not a regression.

### Recording + Screenshot — ONE capture area (view vs simulation) (branch `improvements`)
Recording (WebM/GIF) and screenshot (PNG) share **ONE capture area**. The two areas are fundamentally different renders (NOT a crop of one another):
- **`RecordScope = 'view' | 'simulation'`** — **`captureScope`**, default **`'simulation'`**, persisted in `genesisca_sim_settings` under that key; the single ref `captureScopeRef` is read by BOTH the recording capture and `handleScreenshot`, and by the `setRecording.needColors` flag. Edited by the ONE **"Capture area"** row that leads the capture popover (a `captureSegment`, disabled-in-place in 3D).
- **THE UNIFICATION (2026-08-06), and its migration.** It used to be TWO independent settings — `recordScope` + `screenshotScope`, two rows of one popover — so the same question ("what am I framing?") was asked twice and the two could silently disagree about what a capture of this model means. The state initialiser MIGRATES: `captureScope ?? recordScope ?? screenshotScope ?? 'simulation'` (recording first — the setting a user is likelier to have tuned deliberately), and the legacy keys are simply no longer written, so it is one-way and self-cleaning. **When adding a capture setting, decide which side of the popover's dividing rule it belongs on**: above it are the settings that govern screenshots AND recordings (capture area, cursor & highlights), below it the recording-only ones (format, quality, overload).
- **`'view'` (current view)** = the DISPLAY canvas exactly as shown — WYSIWYG, respects zoom/pan/margins. 2D reads `canvasRef` (the FINAL composited surface for every 2D path) via the CPU-backed `recordScratchRef` (drawImage → scratch = texture READ, safe; getImageData the willReadFrequently scratch — NEVER the live display, the ~6× de-opt rule); recording locks only the OUTPUT dims on the first frame (`recordCropRef`, {outW,outH}, RECORD_MAX=960) so a panel resize can't change frame size. Screenshot copies the display to a throwaway offscreen (full display res).
- **`'simulation'` (the fix — the load-bearing correction)** = the WHOLE grid/world at a FIT framing, **INDEPENDENT of the current zoom/pan**, so it captures the entire simulation no matter how far you've zoomed in to inspect a part. Rendered on the MAIN THREAD from data that's always available while recording — **`renderSimulationFrame(maxSize, target?)`** ([SimulatorView.tsx](src/simulator/SimulatorView.tsx)): the **colours buffer** (grid, `colorsRef` → a W×H temp → drawImage-upscaled nearest-neighbour into a grid-aspect offscreen) + the **agent snapshot** (circles + bonds at the fit transform). Output is grid-aspect (W:H) → NO letterbox margins by construction, and needs no lock (deterministic dims). Works on EVERY compile target incl. WebGPU direct render / E2 composite / A1 agent direct (which otherwise only expose the current-view framing via the worker's transferred canvas — the main-thread data-render sidesteps the worker camera entirely). Recording reuses a persistent `simCaptureRef` offscreen (getImageData on a never-displayed canvas is de-opt-safe); screenshot uses a fresh offscreen (toBlob is async), sized `min(2048, max(720, max(w,h)))`.
  - **⚠ THE SIMULATION SCOPE READS THE CPU COLOURS MIRROR, SO A CAPTURE MUST RE-ARM IT ON EVERY GPU-OWNED DISPLAY PATH** (the "the GIF records the agents but not the grid" bug, fixed 2026-08-05). `renderSimulationFrame` draws the grid from `colorsRef` — the mirror the worker ships on `stepped`. Every GPU display fast path deliberately STOPS shipping it, so the capture drew agents over a grid frozen at whatever was last shipped. The escape hatch existed for `gridDisplayOwnedByGpu()` only; the **E2 grid+agents composite** (`agentCompositeActive`) suppressed BOTH the readback (`needColors: !agentCompositeActive`) and the ship (`|| agentCompositeActive`) **unconditionally**, so on a 2D grid+agents model with both layers on WebGPU — **Chemotaxis**, and every model the library's WebGPU-where-supported policy puts there — the recorded grid never advanced. **Measured:** 940 `stepped` messages, **0** carrying colours. **The fix is a capture-scope-aware want-flag**, not a blanket one: `setRecording` carries **`needColors`** (absent ⇒ true, back-compat) = *is this the SIMULATION scope*, the worker stores it as **`recordingNeedsColors`**, and THAT (not the raw `recording`) is the term in `finalizeStepWebGPU`'s `wantColors`, in the `sendColors` ship gate — now `(gridDisplayOwnedByGpu() || agentCompositeActive) && !recordingNeedsColors` — and in the batch's `runColorPassWebGPU` guard (so ∞ gens/frame can't starve a capture either). **A "current view" recording therefore KEEPS the no-readback fast path** (it reads the display canvas, which every GPU path already presents into): measured 0 colours shipped across 47 frames on a direct-render model, where the old blanket flag read back W·H·4 per frame for bytes nobody read. **A SCREENSHOT never sets the flag at all**, so its simulation scope was stale on *every* GPU-owned path (composite AND plain 2D direct render) — it now does the one-shot `requestColorsSnapshot` round-trip first (via the previously-dead `screenshotPendingRef`, with a 2 s safety net so a lost reply degrades to the old behaviour instead of hanging), and the worker's handler routes through the new **`gridColorsMirrorStale()`** = `gridDisplayOwnedByGpu() || agentCompositeActive` (its old `rt.directRender || rt.voxelRender` test is FALSE under composite, because the grid canvas attach is gated on `!agentModel`). **Verified by A/B on the real UI**, grid pixels compared with agents masked: pre-fix emulation (`needColors:false`) → **98.25 % of grid pixels IDENTICAL across all 39 frames** (frozen) vs fixed → **0.05 %** identical, the last frame closest to an independent live readback (meanAbs 10.1 vs 26.9 for the first); the simulation-scope screenshot matches the live field **pixel-for-pixel (0 of 518 400 differ)** on a grid-only WebGPU model and 96.2 % exact on Chemotaxis (the rest is agent bodies); 0 colours ship after Stop (0 of 73 `stepped`). **The E2 composite also joined L1's per-batch colour-pass refresh** (`voxelDisplayLive() || agentCompositeActive`) — its canvas is a real DOM canvas the browser composites, so skipping the colour pass at ∞ gens/frame froze the grid half of the *display* the same way.
  - **THE SIMULATION-SCOPE AGENT RENDER IS CIRCLES + BONDS + GLOW + SPRITES, all from the DISPLAY OVERLAY'S OWN CODE.** Glow shares `drawAgentGlow`; **sprites share `resolveAgentSpriteDraw` + `paintAgentSprite`** (2026-09-01, closing the recorded follow-up — the extraction the old note asked for, done at the granularity that matters). **THE POINT OF EXTRACTING RATHER THAN RE-IMPLEMENTING: a recording that disagreed with the screen about a sprite's size, frame, facing or alpha would be a silent, plausible-looking lie.** `resolveAgentSpriteDraw(snap, i, hw, meta, dec, radPx, scale)` owns the WHOLE per-agent resolution — the `spriteSpan` rule incl. the `sizeMode: 'absolute'` arm and its `MIN_SPRITE_SPAN_PX` floor, the frame floor+wrap(loop)/clamp(once), the `orientToVelocity` → `defaultDirection` → `rotationOffset` facing chain, the aspect shaping and the per-agent alpha — and returns `spanPx` **even when the sprite has no decoded frames**, because each caller's viewport cull needs the sprite's half-span BEFORE it knows there is a bitmap (a 3× asset scale, or an absolute size on a tiny agent, far exceeds the disc). `draw` is null there and the caller falls back to the disc, exactly as an undecoded / deleted slot always has. The only path-specific inputs are `radPx` and `scale` — each path's own transform, correctly so.
    - **The snapshot needed NO worker change**: `snapshotAgentsForRender(store, hasAgentSprites, …)` gates the four sprite arrays AND `vx`/`vy` on `hasAgentSprites`, which is a MODEL property (`model.sprites.length > 0`), not a per-consumer request — so a sprite model always ships them and the capture cannot hit the documented "un-requested field silently reads as 0" trap. (The arrays are length-0 for a non-sprite model, so `spritesActive` is false and the branch costs nothing.)
    - **METABALLS are the ONE remaining exception** — the fused blob is an SVG-filter composite over the whole display surface, not a per-agent draw, so it has no per-agent form to share. Use the current-view scope for those. The GRID layer is full-fidelity (the colours buffer).
    - **Verified by pixels, A/B across a `git stash` boundary** (2D sprite model, GIF + simulation scope, 912², same frame size): **BEFORE 0 sprite px / 358 246 disc px → AFTER 60 645 sprite px / 0 disc px**; the same for a decoded **WebM** frame (60 645 / 0) and a simulation-scope **PNG** (38 645 / 0). Semantics checked numerically against the display at the SAME instant, on a population thinned to 4 isolated agents (radius 0.4): **radius-relative** sprite ink bbox **4 × 10 px** in the capture (scale 12, predicted span `2·max(1.2, 0.4·12) = 9.6`) vs **4 × 11–12** on the display (scale 15.23, predicted 12.19); **`sizeMode: 'absolute'` scale 6** gives **30 × 69 px** in the capture (predicted `0.41·72 × 0.96·72 = 29.5 × 69.1`) and **38 × 87** on the display (predicted 37.5 × 87.7) — a measured cross-path ratio of **0.789 against the exact scale ratio 0.7877**. **Rotation is proven, not assumed**: the source Arrow's ink is **576 × 246 (a WIDE horizontal arrow)** and BOTH paths render it TALL, which is only possible if `rotDeg = 0 − defaultDirection(270) + 0` is applied.
  - **Why NOT the earlier crop-the-current-view approach:** the first implementation cropped the display to the drawn world rect (`simCropRect`, deleted). That only removes letterbox margins at FIT-view; **when zoomed in the sim fills the canvas so there's nothing to crop → "simulation" == "current view"** (the user's reported bug — "both save the current view"). The fit-render is zoom-independent, so it's correct at any zoom AND removes margins at fit-view (superset of the old behaviour). `viewXformRef` is no longer read by capture (still used by the cursor overlay).
- **Every 2D capture target is filled with `CAPTURE_BACKDROP` (opaque black) BEFORE the content is drawn** — the view scratch by an explicit `fillRect` replacing its `clearRect`, the simulation offscreen by `renderSimulationFrame(..., opaqueBackdrop = true)` — so the browser does the premultiplied composite and the `getImageData` readback is already correct; `forceFrameOpaque` then only kills margin / translucent-cell GIF-disposal trails and is a no-op on 2D. **Skipping this is the "glow records super-saturated" bug** — see the `forceFrameOpaque` section above for why (un-premultiplied readback) and the measurements. **3D** reads the WebGL2 buffer (`capture3dPixels() ?? readPixels()`; the scene fills the frame, no letterbox → both scopes = the full frame) and needs NO backdrop — those bytes are already premultiplied.
- **3D UI:** the recording `<select>` shows only the two FORMATS (`WebM`/`GIF`, no scope suffix) and the screenshot scope `<select>` is HIDDEN. `is3D` gates the option rendering; picking a format in 3D does NOT overwrite the persisted 2D scope (`if (!is3D) set…Scope`), and the select value is coerced to `…:view` in 3D so it matches a rendered option.
- **Option readability**: the transport-bar `<select>`s carry `.transportBtn` styling that leaves the expanded native `<option>` popup unreadable (light text on a white OS popup); each option gets a concrete dark-bg/light-text `PICK_OPT_STYLE` + the select's own `color:'#eaeaea'`.
- **`screenshotPendingRef` / `requestColorsSnapshot('screenshot')`** is now dead-but-harmless (the worker `stepped` consumer stays; nothing sets it). Verify a recording via the actual Record button + inspecting the downloaded file's dims (GIF header bytes 6–9), not synthetic capture — and note zoomed-in is the case that distinguishes the two scopes.

### Agents — no longer leak from a previously-loaded model
Loading a new model left the previous model's agents rendered — seen in 3D (the gl3d agent instance buffer is only refreshed inside `if (isAgentModelRef.current)`, and the 3D viz flag was `agents: !isAgentModelRef.current || …` = **true** for a non-agent model → it kept drawing stale spheres). Three-part fix in [SimulatorView.tsx](src/simulator/SimulatorView.tsx): (1) the full-reinit path resets `agentsRef.current = null` + `lastUploadedAgentSnapRef.current = null` (a `.gcaproj`/library load always full-reinits — nbr/mapping array refs change); (2) the 3D viz flag is now `agents: isAgentModelRef.current && showAgentsRef.current`; (3) an `else` on the agent-draw block zeroes `r.agentInstanceCount` for a non-agent model. `drawAgentsOverlay` already null-guards the snapshot, so a null `agentsRef` is safe (2D + 3D). **The REVERSE direction (voxels leaking under a newly-loaded AGENTS-ONLY model) is fixed in the `sim_agent_fixes` batch**: the reinit clears BOTH `colorsRef` and `lastUploadedColors3dRef`, so the draw-path guard that zeroed stale voxel instances (keyed on `lastUploadedColors3dRef`) never fired and an agents-only model loaded after a voxel model (Life3D → Morphogenesis 3D Tissue) kept rendering the previous grid — the agents-only worker never ships a colours buffer to overwrite it. The guard now keys on the RENDERER's live `instanceCount` (the no-colours `else` branch zeroes it directly).

### Lookup Tables — user-editable rows/cols + selectable value type
- **Custom axis** — a new `LookupKeySource` kind `{ kind: 'custom'; labels: string[] }` lets the user define an arbitrary ordered set of row/column labels directly on the definition page (alongside face palette / tag attribute / single-value). It flows through **`resolveKeyLabels`** (the single source of truth) — verified the JS/WASM/WebGPU compilers + the worker (`normalizeLookupTable`) all derive `rowCount/colCount` from `resolveKeyLabels(...).length`, so custom needs NO per-target code (a custom N-label axis compiles identically to a tag axis with N options). `attrsStructurallyEqual` already JSON-compares `rowKeySource`/`colKeySource`, so adding/removing a custom label triggers the correct worker reinit. UI: `KeySourceField` ([AttributesPanelContent.tsx](src/modeler/panels/AttributesPanelContent.tsx)) offers "Custom labels…" + an inline add/remove/rename label editor. **Labels are kept UNIQUE** — `tableValues` is keyed by label NAME, so two columns with the same name would share one cell (editing one edits both) and leave a "ghost" empty column after a rename. `dedupeCustomLabels` (in [variegation.ts](src/modeler/vpl/compiler/variegation.ts)) suffixes later duplicates ` (2)`/` (3)` (empty → `label`); it runs BOTH on every editor commit (so duplicates never enter the model) AND inside `resolveKeyLabels` for the `custom` kind (defensive — a hand-edited dup file renders distinct columns and self-heals on the next edit). The label inputs use a draft+blur `CustomLabelInput` so the de-dup doesn't fight typing keystroke-by-keystroke (commit on blur/Enter; the field then shows the final unique name). **Rename preserves data:** `UPDATE_ATTRIBUTE` remaps `tableValues` keys on a custom-axis rename via the SAME index-paired name heuristic used for tag-attribute axes (`applyCustomAxisRemap` in [ModelContext.tsx](src/model/ModelContext.tsx)) — without it, renaming a custom label orphaned that row/column's values (they read back as 0 on every target). Added labels start empty; removed labels' values drop.
- **Value type** — `Attribute.valueType?` (lookup table only; default `'float'`), restricted to **bool / integer / float / tag** — the scalar-numeric types that fit ONE stored number exactly on all targets. **DESIGN DECISION (documented per request):** the value is stored + emitted as a single NUMBER that is exactly correct for the type (bool → 0/1, tag → index, integer → whole, float → the number). This is intentionally **UI + semantic + authoring** only, with **zero compiler emit change**: `tableValues` stays `Record<string, Record<string, number>>`, and `lookupInteraction`/`interactionTableMap` still read a float from the table region. Rationale for NOT changing the byte-level storage/emit per type (even though it was on the table): (a) GenesisCA's value ports coerce freely — a Binary table's `0/1` output already works wherever a bool is expected (the user's Golly Born/Survive table wires the lookup straight into a bool `Set Attribute`), so the type IS respected end-to-end; (b) the value fits a float EXACTLY for bool/int/tag, so a per-type typed-array storage would save only bytes on tiny tables (negligible) at real 3-target risk — the **WebGPU f32-bitcast table region genuinely cannot hold an exact i32**, which is precisely why `color` (needs a multi-output read) and `neighborIndex` (needs exact-int f32) are the two value types NOT offered (a scope boundary, not a JS-only clamp). [LookupTableEditor.tsx](src/modeler/panels/LookupTableEditor.tsx) renders a per-cell widget by value type (bool → a **checkbox** [not a true/false dropdown], tag → InlineTagSelect over the resolved tag values, int/float → NumberField). **Tag value labels** come from `resolveValueTagOptions(attr, model)` ([variegation.ts](src/modeler/vpl/compiler/variegation.ts)): either a MANUAL `valueTagOptions` list OR (when `valueTagAttributeId` is set) an EXISTING tag attribute's `tagOptions` (a "Custom values… / from tag attribute" dropdown in the value-type row, mirroring how an axis can be keyed by a tag attribute). The RESOLVED options are passed as a `valueTagOptions` prop to LookupTableEditor (both the design-time + simulator call sites resolve). Cascade ([ModelContext.tsx](src/model/ModelContext.tsx)): `REMOVE_ATTRIBUTE` detaches a dangling `valueTagAttributeId` (→ manual fallback); a tagOptions reorder/removal on the referenced attr remaps the stored value INDICES via the same indexMap (a rename is index-stable). No compile impact (the value is still a float index). **Golly use case:** custom labels (rows = neighbour counts 0-8, cols = Born/Survive) + `bool` value type = a Golly-style Born/Survive rule's on/off table with NO internal tag model attributes and NO decimal placeholders — see the `General 2D CA (Golly style)` library sample. Additive schema; old files load unchanged (no migration).

### Agent Sprites — rotation, chroma-key, image sequence, sprite sheet
Extends the sprite exhibition layer ([spriteRegistry.ts](src/simulator/spriteRegistry.ts), `SpriteAsset`). All additive; non-sprite models byte-identical.
- **Rotation:** three layers. Per-SPRITE `SpriteAsset.defaultDirection` (compass degrees, 0=up, edited via a `CompassDial` widget in [MappingsPanelContent.tsx](src/modeler/panels/MappingsPanelContent.tsx)) = which way the ART faces; `orientToVelocity` (auto-rotate the art to the agent's heading) + `rotationOffset` (fixed extra degrees). PER-AGENT `spriteRotations` (compass degrees, an engine Float64Array) set by the **Set Agent Sprite node's Set-rotation facet** — either an ANGLE input or a `Dir X`/`Dir Y` VECTOR the art aligns to via `atan2(dx,-dy)` (so a STATIC agent can "look at" a target). The render (`drawAgentsOverlay`) computes `facingDeg = orientToVelocity&&moving ? velHeading : spriteRotations[i]` then `rot = (facingDeg − defaultDirection) + rotationOffset`. `spriteRotations` rides the agent-loop ABI (see below).
- **Scale:** per-AGENT `spriteScales` (engine Float64Array; 0 = use the sprite asset's `scale`, >0 = override) set by the Set Agent Sprite node's **Set-scale** facet. The render uses the per-agent override when >0.
- **SIZE MODE — `SpriteAsset.sizeMode?: 'radius' | 'absolute'` (additive, ABSENT ⇒ `'radius'` ⇒ every pre-sizeMode file byte-for-byte unchanged; no migration).** It decides what BOTH the asset's `scale` and the per-agent `spriteScales` override MEAN, so the Sprite Library's field and the node's `Scale` port can never diverge: **`radius`** (default) = a multiplier of the agent's DIAMETER, the historical `radius*2*eff`; **`absolute`** = the drawn size in WORLD UNITS, with the agent radius **not consulted at all** — what "the Scale input should dictate the sprite size, and the agent radius should never enter it" means. Either way the number is the sprite's **LONGEST side** (the other shortened by the frame aspect). Edited in the Sprite Library detail editor (a **Size mode** select; the size field's label follows it).
  - **PER-ASSET, not per-node, deliberately**: the sizing is a property of the ART ("how big is this picture in the world"), the meta is already plumbed to all four renderers, and a per-node value would let two Set Sprite nodes disagree about one asset. It rides `SpriteMeta.flags` bit **`SPRITE_FLAG_ABSOLUTE = 4`** on the GPU, so `SPRITE_META_BYTES` (32) never moves.
  - **ONE rule, four paths.** `spriteSpan(diameter, assetScale, perAgentScale, absoluteSize)` ([SimulatorView.tsx](src/simulator/SimulatorView.tsx)) is the shared definition; the 2D CPU overlay, the 2D worker WGSL billboard pass ([agentWebgpuRuntime.ts](src/simulator/engine/agentWebgpuRuntime.ts) `agentSpriteWGSL`, shared by `presentAgentsEncode` AND the E2 `presentCompositeEncode`) and the 3D gl3d billboard + its **pick radius** all apply it. `renderSimulationFrame` draws no sprites, so there is nothing to change there.
  - **The 2D pixel floor**: the relative arm floors the RADIUS at 1.2 px (bottoming its span out at 2.4 px for scale 1); the absolute arm has no radius to floor, so it floors the SPAN at **`MIN_SPRITE_SPAN_PX = 2.4`** for the same reason. 3D floors neither (its discs are unfloored world-unit spheres).
  - **The CPU overlay's viewport CULL now uses the sprite's half-span**, not the disc radius — a 3× asset scale (or an absolute size on a tiny agent) already exceeded the disc, so large sprites popped off at the edges while still mostly on screen. The span is resolved ONCE before the cull and reused by the draw.
  - **Verified by measurement, all four paths.** CPU overlay (real `drawImage` spy, 3721 agents, half at 3× radius): radius mode gives exactly TWO spans in ratio **3.000** (25.707 / 77.12, split 1860/1861), absolute gives **ONE** span (32.133) for all; the per-agent override in absolute mode matches `spriteScales[i] × scalePx` on all 3721 agents to **7.4e-5 px** with two distinct radii present. Worker WGSL (real GPU, one isolated sprite): lit area **88 → 800 (ratio 9.09 ≈ 3²)** in radius mode vs **138 → 138 (ratio exactly 1)** in absolute. gl3d 3D (the real sprite instance buffer): halfW/halfH **0.8 vs 2.4** in radius mode, **1.0 vs 1.0** in absolute. Shipped `Boids - Flocking` (asset scale 3, `setScale` off, `spriteScales` all zero) unregressed. Pinned by the `[sprite]` block in [verify-agent-render.mjs](scripts/verify-agent-render.mjs).
- **Set Agent Sprite is now a BY-ID setter** ([SetAgentSpriteNode.ts](src/modeler/vpl/nodes/SetAgentSpriteNode.ts)): an optional `agentId` input targets a specific agent (a **Create Agent handle** — so a sprite CAN be set at spawn time inside the **Agent Init Event**, with an `_agentMaxAgents` range guard like `setAgentPosition`); left unwired it targets the current-loop agent `idx` (the typical Output-Mapping / Behaviour use). **Init-event fix:** an unwired Set Agent Sprite in the Agent Init Event is now a safe **no-op** (`ctx.agentRoot==='init' && !wired → return ''`) instead of emitting `spriteIds[idx]` — the init event is NOT a per-agent loop, so `idx` was undefined (the "`[agents] init event failed: idx is not defined`" bug). For agents that are seed-painted (not created in init), place Set Agent Sprite in an **Agent Output Mapping** (or Behaviour) graph — it runs per-agent.
- **`spriteRotations` + `spriteScales` ride the agent-loop ABI** (the THREE-mirror discipline): `buildAgentLoopParams`/`buildDivisionParams`/`buildAgentInitParams` push them after `spriteSpeeds`; the worker's `buildAgentLoopArgs`/`buildDivisionArgs`/`buildAgentInitArgs` + the empty-store snapshot + `scripts/parity-agent-wasm.mjs` `buildArgs` mirror them; `AgentStore` allocates them, `initAgentSlot` zeroes them, `divideAgent` inherits them, the render snapshot ships them when `hasAgentSprites`, and `serializeAgentStore`/deserialize round-trip them. JS-only param list (the WASM/WebGPU behaviour ABIs are untouched — the WASM emit reads the sprite MEMORY REGIONS at baked offsets, not ABI params). Verified: JS↔WASM bit-parity on all agent samples unchanged.
- **Chroma key:** `removeBgColor` + `removeBgTolerance` — matching pixels are made transparent at decode time via an offscreen-canvas pass (`applyChromaKey`). The Sprites panel adds a **`SpriteBgPicker`** — a small canvas of the sprite's first frame; **clicking a pixel sets `removeBgColor`** to that pixel's hex (the native colour picker covers the sprite, so this lets the user pick the background off the image directly).
- **Image sequence:** `SpriteAsset.frames?: string[]` — several imported images become one animated sprite (filename order).
- **Sprite sheet:** `SpriteAsset.sheet?: SpriteSheetSpec` (cols/rows/count + margin/spacing + **`frames?: number[]`** + an optional explicit **`cellW?`/`cellH?`**) — one grid image sliced into frames (`sliceSheet` via `createImageBitmap` crop). **The GEOMETRY and the frame SELECTION both live in [spriteSheet.ts](src/model/spriteSheet.ts)** — see the next section.
- **Crop:** `SpriteAsset.crop?: SpriteCropRect` — see the "Sprite CROP" section below.
- Decode is restructured into **`decodeSpriteAsset`** (sequence → sheet → animated → static, **then crop, then chroma-key**); the `SpriteRegistry` re-decodes on a **decode-signature** change (dataUrl/frames/sheet/**crop**/chroma), not just dataUrl. Import UI adds "+ Frame sequence" (multi-file) and "+ Sprite sheet" buttons.

#### Sprite-sheet FRAME SELECTION — pick which cells, in which order (branch `tasks_batch_2026_08`)
A sheet's frames were forced to be a **row-major PREFIX** of the grid (`count`), but real sheets almost never hold one animation — a walk cycle sits beside an idle pose, a door, a UI icon. Isolating one cycle therefore meant fighting the Set Agent Sprite node's frame/speed inputs to skip the cells you did not want. **`SpriteSheetSpec.frames?: number[]`** is an ORDERED list of grid-cell indices that ARE the animation, so a sheet behaves exactly like an imported frame SEQUENCE and speed becomes trivial again. **Presentation + decode only** — `git status` touches no compiler/worker/engine file, and `check-compile-identity` reports **31 models, all surfaces unchanged**.
- **ABSENT ⇒ the historical behaviour BYTE-FOR-BYTE** (the first `count` cells row-major, or every cell) — no migration, and every sheet authored before the selection slices identically. **`frames` SUPERSEDES `count`** when present (the editor clears `count` when it writes a list).
- **[src/model/spriteSheet.ts](src/model/spriteSheet.ts) is the ONE definition of both the cell GEOMETRY and the frame SELECTION** (dependency-free + DOM-free, so the Node harness drives the shipped code). `sheetGrid` / `derivedCellSize` / `sheetCellRect` / `sheetCellRects` / `sheetFrameIndices` / `sheetFrameRects` / `pruneSheetFrames` / `rowMajorFrames` / `sheetWithFrames` / `sheetWithCellSize`. `sliceSheet` CALLS it, so the grid the dialog draws and the pixels the decoder cuts cannot disagree — a stronger guarantee than a documented lockstep pair.
- **DUPLICATES ARE ALLOWED, deliberately**: `[0,1,2,1]` is a ping-pong cycle, the cheapest way to author a back-and-forth, and it costs nothing (the same cell decoded twice is two bitmaps).
- **OUT-OF-RANGE indices are DROPPED, never clamped** — a clamp would silently animate the WRONG cell. If pruning empties the list the row-major default is used, so a sheet can never become frameless.
- **`sheetWithFrames` folds a selection back into the SMALLEST spec**: the whole grid in order ⇒ neither field; a row-major prefix ⇒ the legacy `count` shape; anything else ⇒ `frames`. So a legacy-shaped selection keeps its legacy record instead of gaining a redundant index list.
- **THE PROPAGATION NEEDED NO PLUMBING**: `decodeKey` (renamed `spriteDecodeKey`, exported for the harness) serialises `sheet` WHOLESALE, so a selection edit changes the signature → `SpriteRegistry.sync` re-decodes → its existing `onReady` marks the 3D atlas dirty, re-ships the worker's 2D atlas and redraws. Frame COUNT changes therefore flow to the CPU overlay, gl3d and the GPU sprite billboard pass for free.
- **[SpriteSheetDialog.tsx](src/components/SpriteSheetDialog.tsx)** is now the primary gridding surface: a FIXED-size pan/zoom viewport (the Map-Image-to-Cells layout rule — sizing the viewport to the image reflows the card mid-drag, the "feedback loop"), the grid NumberFields MOVED out of the panel, click-a-cell-to-toggle with ordinal badges, an ordered strip (`×` remove · `⧉` repeat · `◂ ▸` nudge) + Select all / Reverse / **Ping-pong** / Clear, and a live cycling preview. Unselected cells render DIMMED and selected ones at full brightness, so "what is in the animation" reads at a glance. A grid change prunes + says how many frames it dropped.
- **The dialog IS the import step** — "+ Sprite sheet" no longer adds a `{cols:4,rows:4}` asset immediately; nothing enters the model until Apply (Cancel/Esc discards). The panel keeps a summary + **Edit sheet grid…**. Both mounts of the Mappings panel render their own dialog (list = import, detail = edit), each with its own state.
- **`setPointerCapture` fires only for a real DRAG** (pan, or a first-cell gizmo gesture), never on a plain press — capturing on a click buys nothing and is what makes a canvas undrivable from a synthetic pointer event. It is additionally wrapped in try/catch (`tryCapture`), so a synthetic pointerId the browser never issued cannot throw the handler out mid-gesture.
- **Gate: [scripts/test-sprite-sheet.mjs](scripts/test-sprite-sheet.mjs)** (**100 checks**): the geometry by hand-computed rects; **tier B compares the absent-selection path against an INDEPENDENT transcription of the pre-change `sliceSheet`** over 8 spec shapes (the back-compat claim, not a mirror); the selection semantics (order, the discriminator assertion, duplicates, drop-not-clamp, the stranded fallback, `frames` over `count`); the `sheetWithFrames` fold + its round trip; the **explicit cell size** (tier F) and **its fold** (tier G); and the decode signature (a selection edit / reorder / duplicate / cell-size edit changes it, an unrelated field does not, and a FOLDED size keys identically to a never-sized sheet). **Negative-controlled by SOURCE MUTATION — 5 mutations, 5 caught**: clamp instead of drop (6 failures), ignore the selection (11), drop the spacing from the cell rect (4), ignore the explicit cell size (16), never fold the cell size (5).

#### The FIRST-CELL gizmo + the optionally-EXPLICIT cell size (branch `tasks_batch_2026_08`)
Aligning a grid by typing six numbers is guesswork, and the derived cell size is **locked to the
FULL image extent** — so a sheet with trailing dead space on the right/bottom could not be gridded
correctly at ALL. The dialog draws the grid's **first cell** as an orange rectangle: drag its BODY
to move the grid origin (writes `marginX`/`marginY`), drag its CORNER to scale the cells. The
NumberFields remain and sync both ways. Plan + mockup: [docs/PLAN_SPRITE_SHEET_GIZMO.md](docs/PLAN_SPRITE_SHEET_GIZMO.md)/`.html`.
- **`SpriteSheetSpec.cellW?` / `cellH?`** (additive, optional): **ABSENT ⇒ DERIVED exactly as
  today, byte-for-byte** — every existing `.gcaproj` slices identically, **no migration**. Present
  ⇒ used as-is, sanitised `max(1, floor(·))` so a hand-edited 0 / NaN can never make a zero-area
  cell. `derivedCellSize` is exported so the fold and the reset affordance share the one formula.
- **THE FOLD RULE — `sheetWithCellSize(sheet, cellW|null, cellH|null, imgW, imgH)`**, the geometry
  twin of `sheetWithFrames`: a size EQUAL to the derived one is **not stored** (the keys are
  deleted), so a drag that lands back on the derived geometry keeps the LEGACY record shape and
  keys identically for the decoder. It deletes the old keys BEFORE computing the derived size —
  otherwise an explicit size would compare against itself and never fold. The axes fold
  independently. Applied ONCE, at Apply.
- **The dialog holds the size as `number | null`** (null = derived) rather than always-a-number, so
  "derived" SURVIVES a cols/rows edit; the `↺` button (visible only when explicit) restores it.
- **A press on the first cell's body is PROVISIONAL** — it becomes a move only past
  `GIZMO_DRAG_PX`(3); released under that it TOGGLES cell 0. Without this the gizmo would make
  cell 0 the one cell that can never be clicked into the animation. Hit priority: handle → body →
  the existing cell-toggle / pan. Drags commit integer-rounded values against the drag's OWN start
  values, so dragging back and forth cannot drift.
- **A cell may now hang off the image** (reachable only with an explicit size). The rect is
  reported HONESTLY and never clamped — `createImageBitmap` crops with transparent padding, and a
  clamp would silently resize one frame.
- **Real-UI verified** on a synthetic 100×100 sheet of nine 30-px colour cells with 10 px of dead
  space (the motivating case, where derived = 33 is simply wrong): the corner drag took the cell
  33→30 with the fields following live, and the strip thumbnail for cell 2 went from
  **1044 blue + 116 cyan bleed + 440 dead-grey px** to **1600 px of PURE blue, 0 dead**; a body
  drag moved the margin 0,0 → 2,2 leaving the size untouched; a click with no movement toggled the
  frame count 9 → 8 → 9 with the margin unchanged; Apply → reopen round-tripped `30×30` with `↺`
  visible, and `↺` → Apply → reopen showed `↺` **hidden** (the fold dropped the keys). 0 console
  errors on a clean load.

#### Sprite previews show the FIRST FRAME, not the whole sheet
All three preview sites in [MappingsPanelContent.tsx](src/modeler/panels/MappingsPanelContent.tsx)
— the list-row thumbnail, the detail-editor image and the `SpriteBgPicker` — render a sheet's
**first ANIMATION frame** (`sheetFrameRects(...)[0]`, i.e. the first cell of the SELECTION, not
cell 0) instead of the whole grid image. ONE shared **`useSpriteFrameSrc` / `SpriteFramePreview`**
serves all three (never three ad-hoc crops); a `frames` sequence resolves to `frames[0]`, a plain
image (an animated GIF/WebP included) is itself. **Chroma-key removal is deliberately NOT applied**
— the picker must show the raw key colour. The hook returns `''` while a crop is in flight so a
caller renders a blank box rather than flashing the whole sheet for a frame. Verified: both
`<img>` sites became **30×30, 900 px of a single colour** = the selection's first cell (green,
NOT cell 0's red — the selection was `[1,2,…,8,0]`), and a centre click on the picker set
`removeBgColor` to **`#00ff00`** where the whole-sheet centre would have been the middle cell's
magenta.
**Since the crop round they show the CROPPED first frame** — `useSpriteFrameSrc` applies the sheet
rect and THEN `resolveSpriteCrop`, so the picker samples the pixels the sprite actually draws
(picking a background colour off padding that is cropped away would be a dead control).

#### Sprite COLORIZE — tint the art by the agent's colour (branch `tasks_batch_01-09`)
**`SpriteAsset.colorize?: boolean`** (additive, **ABSENT ⇒ false ⇒ today's behaviour byte-for-byte**,
no migration): the sprite's pixels are MULTIPLIED by the agent's colour
(`texel.rgb × agentColour.rgb / 255`, **alpha untouched**), so ONE grayscale/white asset serves a
whole coloured population instead of one asset per species. Off, the agent colour still scales the
sprite's ALPHA exactly as it always did. **Zero compiler impact** (`git status` touches nothing under
`src/modeler/vpl/compiler/`); `check-compile-identity`: **31 models, all surfaces unchanged**.
- **MULTIPLY, and it is a per-texel multiply on every path — NOT a Canvas2D blend mode.** The W3C
  separable formula composites the blended colour against the BACKDROP weighted by both alphas, so
  `'multiply'` + `'destination-in'` is only an exact tint at alpha 255 and drifts everywhere else —
  precisely where sprite art lives (its antialiased edges). The CPU path therefore multiplies the
  RGB **in an ImageData pass**, which is exact at every alpha and needs no compositing rules.
- **THE CPU COST IS BOUGHT BY A CACHE, not paid per draw.** A per-agent `filter`/`ImageData` pass
  would run once per agent per frame; instead `tintedSpriteFrame(spriteId, frame, bmp, r,g,b)`
  ([SimulatorView.tsx](src/simulator/SimulatorView.tsx), beside the glow-sprite cache) memoises a
  tinted canvas keyed by **(sprite id, frame, colour QUANTISED to 5 bits/channel)** — the glow
  cache's own key discipline, and what collapses a Color-Scale population to a handful of entries.
  Bounded by BOTH an entry count (`SPRITE_TINT_MAX_ENTRIES` 512) and a **pixel budget**
  (`SPRITE_TINT_MAX_PIXELS` 16 M — a 512-entry cache of large frames is the real memory risk, not
  the count), evicting **oldest-first**; a `Map` preserves insertion order, so eviction is
  `keys().next()`. **On pressure it evicts, never falls back to untinted** — a silently wrong colour
  is worse than a slower frame.
  - **⚠ THE QUANTISER AND DEQUANTISER ARE A MATCHED PAIR, and my own harness caught them drifting.**
    `q = round(v·31/255)` with `(q<<3)|(q>>2)` is exact at 0 and 255 and worst-case 4/255; the
    obvious `v>>3` with the same reconstruction measures **11/255 at v=220**. Tier F of
    [test-sprite-crop.mjs](scripts/test-sprite-crop.mjs) asserts the bound AND (F3b) that it is
    non-vacuous.
- **THE GPU PATHS CARRY THE TINT, THEY DO NOT RE-TINT PER FRAME.** 2D worker WGSL
  ([agentWebgpuRuntime.ts](src/simulator/engine/agentWebgpuRuntime.ts)): a new meta **flag bit**
  `SPRITE_FLAG_COLORIZE = 8` (so **`SPRITE_META_BYTES` (32) never moves** — the `SPRITE_FLAG_ABSOLUTE`
  precedent), the VS unpacks the agent colour into a `tint` varying (**exactly `vec3(1,1,1)` when the
  flag is clear, including the cull path**) and the FS returns `t.rgb * in.tint`. The atlas is
  PREMULTIPLIED, and `(straight × tint) × a ≡ premult × tint`, so multiplying premultiplied RGB by an
  unpremultiplied tint is the same answer — no un-premultiply step. 3D gl3d
  ([gl3d.ts](src/simulator/render/gl3d.ts)): the sprite instance stride grew **9 → 12 floats** through
  ONE constant, `Gl3DRenderer.SPRITE_INST_FLOATS`, which every stride/offset/capacity site reads —
  a hand-written `36` at any one of them is the classic silent-corruption bug this avoids.
- **COLORIZE DOES NOT BUST THE DECODE CACHE** — it changes no pixel of the decoded frames, so it is
  deliberately ABSENT from `spriteDecodeKey` (re-decoding an animated GIF to change a tint would be
  absurd). Every path re-renders instead: the `model.sprites` effect rebuilds the render meta, calls
  `clearSpriteTintCache()`, re-ships the worker atlas and redraws.
- **⚠ A CRASH THE REDRAW EXPOSED, and the rule it leaves behind: `SimulatorView` is ALWAYS MOUNTED**
  (`display:none` on other tabs), so its canvas is **0×0** while the user is in the Modeler — and
  `drawImage` into a 0-width canvas THROWS (`InvalidStateError`), unmounting React. Toggling colorize
  from the Modeler did exactly that via the metaball goo path. **Every draw call added outside the
  step loop must be `visibleRef.current`-gated**; the pre-existing unguarded `drawRef.current()` in
  the registry's `onReady` is gated now too.
- **Verified by pixels on all three paths** (real UI, a throwaway model whose agents carry six
  saturated colours and a WHITE sprite, so the multiply is decisive): CPU overlay + worker billboard
  + 3D each render the six agent colours where the art is white; **black art stays black**; and — the
  headline — **colorize OFF is BIT-IDENTICAL to the pre-change build** (`git stash` A/B with the
  population pinned by `pasteAgents` so both builds render the same state: FNV hash **3329000182**,
  18 123 lit pixels, over a 1080×914 frame with 260 sprite agents, repeatable on both sides). Pinned
  by three invariants in [verify-agent-render.mjs](scripts/verify-agent-render.mjs) (rgb-only tint
  with alpha kept · the exact `vec3(1.0)` identity including the cull path · the flag bit with
  `SPRITE_META_BYTES = 32`), which REPLACED the older "the sprite is untinted" pin rather than
  deleting it.

#### Sprite CROP — a rectangle for NON-sheet assets (branch `tasks_batch_01-09`)
A sheet is cropped by its grid; a plain image, an animated GIF/WebP or a frame SEQUENCE had no
cropping at all and rendered exactly as imported — **padding included, which sets the drawn size just
as much as the art does**. **`SpriteAsset.crop?: SpriteCropRect` (`{x,y,width,height}` in SOURCE
pixels, additive, ABSENT ⇒ no crop)** is applied **at DECODE time to EVERY frame**, in the same seam
the chroma key sits in — after frame extraction, **before** the chroma key (so a key colour is
matched on the pixels that survive).
- **[src/model/spriteCrop.ts](src/model/spriteCrop.ts) is the ONE rule** (dependency-free + DOM-free,
  the `spriteSheet.ts` pattern, so the decoder, the dialog, the panel previews and the Node harness
  all run the same code): `resolveSpriteCrop` (**null = use the whole frame**) / `clampSpriteCrop`
  (the EDITING rule — never returns null, so a rect cannot vanish mid-drag) / `fullSpriteCrop` /
  `spriteCropIsFull` / **`spriteCropPatch`** (the FOLD — a rect equal to the whole image is NOT
  stored, mirroring `sheetWithCellSize`, so a drag that lands back on the full image leaves the asset
  in its legacy shape and every consumer stays on the no-crop path).
- **CLAMPED PER FRAME, deliberately**: a frame SEQUENCE is N independent files that may differ in
  size, so one stored rect is reconciled with each frame rather than with "the" image. A
  **degenerate or fully-outside rect degrades to the WHOLE frame, never to a zero-area bitmap** —
  a frame that cannot be produced would take the sprite off screen entirely, far worse than ignoring
  a rect that says nothing about this frame.
- **It IS in `spriteDecodeKey`** (unlike colorize): it changes the decoded pixels, so the registry
  must re-decode. The decoder closes the bitmap a crop supersedes and keeps the ORIGINAL object
  (no copy) when the resolution is null.
- **[SpriteCropDialog.tsx](src/components/SpriteCropDialog.tsx)** is a lean sibling of
  `SpriteSheetDialog` for NON-sheet assets (a sheet is cropped by its grid, so the row is hidden
  there — the structurally-impossible rule), reusing its viewport discipline verbatim: a **FIXED-size
  letterboxed viewport** (sizing it to the image reflows the card mid-drag — the documented feedback
  loop), pan/zoom, a crop box with move / corner-resize / draw-new at hit priority **handle → inside
  → outside**, `tryCapture` on real drags only, numeric x/y/w/h `NumberField`s, "Full image", and a
  frame stepper for sequences.
- **Verified end-to-end in the real UI** on a 64×64 frame that is transparent except for a white
  16×16 block at (24,20): the **draw gizmo lands exactly on `24,20,16,16`** (and a press inside the
  full-image box correctly MOVES it instead — hit priority working); Apply took the white pixel count
  **3189 → 42841 (13.4×, fully opaque)** = the quad is now all art; **all 4 frames of the sequence are
  cropped** (~43k across six stepped samples — a single uncropped frame would collapse to ~3k);
  re-editing to `24,20,32,32` **without a reload** gave **11 601 ≈ ¼** (16×16 art inside a 32×32 crop),
  the decode-signature invalidation proven quantitatively; the dialog **reopens with the applied
  rect**; Clear returns the row to "whole image", removes its own button and restores ~3155 ≈ the
  3189 baseline (the fold); and the real **Save** path writes `crop: {x:24,y:20,width:16,height:16}`
  and `colorize: true` into the `.gcaproj`. Guarded by
  [scripts/test-sprite-crop.mjs](scripts/test-sprite-crop.mjs) (Tiers A–G: the null cases, real rects
  by value incl. the per-frame sequence clamp, the editing clamp, the fold, the decode signature
  — crop yes / colorize no —, the colorize multiply + quantisation, and the decoder ordering pins).

### "Map Image to Cells" dialog (replaces the 2D Open-Image import)
A [ImageMappingDialog.tsx](src/simulator/ImageMappingDialog.tsx) modal: source image (left, with a draggable/resizable region box + a cell-grid overlay) + gridified preview (right). Setup: Input-Mapping picklist, average-pixels, invert, binarize+threshold, **resize-grid vs paste-centered**, and **"use manual input mapping"** (binarize-true cells painted with the manual-brush values, embeds `ManualBrushPanel`). Also opens on **Ctrl+V** of a clipboard image (a window `paste` listener, latest-ref, `visibleRef`-gated). The pure sampler is [imageMapping.ts](src/simulator/imageMapping.ts) (`gridifyImage` → `{cols, rows, pixels, mask}`). Apply covers 4 combos: resize (reinit to cols×rows, then `importImage` or a pending `paintManual`) × center (keep grid; `importImage` with a region, or `paintManual` on centred cells). The worker's **`importImage` gained an optional `region`** — paste-centered writes ONLY the sub-region (cells outside preserved); under WebGPU with `gpuOwnsAttrs` (post-Play) it uses **`patchWebGPUCells(regionIdxs)`** instead of a full `uploadAttrs` so evolved cells outside the region aren't clobbered by the stale CPU mirror. **2D-only** (the worker's per-cell `importImage` is 2D-linear); a 3D model keeps the classic 1px=1cell resize import.

**Dialog rework (usability round):** (1) The **Open Image button is never disabled** — the dialog covers the no-mapping case itself. It takes `initialUseManual` (= the brush being on the Manual tab); `useManual` defaults to `initialUseManual || colorToAttrMappings.length === 0`, so opening from Manual (or a model with no C→A mapping) pre-selects the manual path (Apply is never dead), while opening from a colour tab pre-selects that mapping. (2) A second **"cell reference" square** (orange, alongside the blue included-area box) sets BOTH the sampling **cell size** and the **grid phase**: the sampler's new **`gridLayout(region, cellSize, cellOriginX?, cellOriginY?)`** returns the phase-anchored origin `gx/gy` (the first lattice boundary `ax + k·cs` inside the region) + `cols/rows`; `gridifyImage` samples from `gx/gy`. **Backward-compatible** — absent anchor (or anchor == region origin) ⇒ `gx=region.x`, `cols=floor(region.w/cs)`, byte-identical to before (the output pixels/mask shape is unchanged, so the worker consumers are untouched). An **"Align to area"** button resets the anchor to the region's top-left. (3) The left viewport is now **pan/zoom** (affine `canvasX = srcX·scale + ox`; wheel = zoom-at-cursor via a native non-passive listener, middle/right-drag = pan, −/+/Fit buttons) so you needn't see the whole image. (4) The **dialog is fixed-size + top-anchored** (`width: min(1000px, 96vw)`, `alignItems: flex-start`) with **fixed-size canvas viewports** (`VIEWPORT=460`, `PREVIEW_BOX=280` container) — resizing the region no longer resizes the card or shifts the canvas mid-drag (the old **feedback loop**: variable-size canvases + a vertically-centred card meant a region resize reflowed the card, moving the canvas under the cursor). onDown hit-priority: cell-handle → cell-body → region-handle → region-body → draw-new. Pointer-drag can't be driven by synthetic events (`setPointerCapture` needs a live pointer) — verify the pure `gridLayout` math + the fixed-layout invariants instead.


### Modeler — topology-aware panels (CA Grid vs Agents) + white event roots
Better separates the two topologies in the modeler UI. All additive/gated; grid-only and agents-only models were already handled elsewhere, this just tidies the panels.
- **Neighborhoods tab elided for an agents-only model** ([ActivityBar.tsx](src/modeler/ActivityBar.tsx)): neighborhoods only apply to the lattice CA, so the tab is hidden when `topologyMode.gridCells === false` (mirrors the V-tab elision for `variegatedCells.enabled`). [ModelerView.tsx](src/modeler/ModelerView.tsx) auto-switches the active panel to Properties if `gridCells` flips off while Neighborhoods is open (same one-line guard as the variegated case; the `gridCellsOn` predicate is `topologyMode?.gridCells !== false`).
- **Mappings panel splits by topology** ([MappingsPanelContent.tsx](src/modeler/panels/MappingsPanelContent.tsx)): the two CA-grid mapping sections (Attribute→Color / Color→Attribute) are gated on `gridCellsOn` — hidden entirely for an agents-only model. When a model has BOTH topologies (`showGroupHeaders = gridCellsOn && agentsOn`), a **`.groupTitle`** header (new class in [PanelContent.module.css](src/modeler/panels/PanelContent.module.css) — bolder than `.sectionTitle`, `--color-accent-strong` underline) prefixes each layer: **"CA Grid"** above the two grid sections, **"Agents"** above the Agent Output Mappings + Sprites sections. A single-topology model shows no group header (no redundancy). (The `mode === 'detail'` editor originally only edited `model.mappings`; since the parity pass it renders EITHER the cell editor or the agent-view editor, whichever the shared `agentmap:`-discriminated slot names — see the Agent Output-Mapping Graphs section's "A2 — parity" bullet.)
- **All event-root nodes are white** (the CA-grid standard): `BehaviourStep` / `DivisionEvent` / `AgentInit` were recoloured `#ffffff` (were `#7e57c2` / `#ad1457`) to match the already-white `Step` / `InitEvent` / `InputColor` / `OutputMapping` / `StopEvent` / `AgentOutputMapping` — every `category: 'event'` node is now white. CaNode's `textColorForBg`/`borderColorFor`/`isLightHeaderBg` already give a light header dark text (`#1e2a3a`) + a visible border, so they render like the other event roots. The Cells/Agents graph-tab identity dots ([GraphEditor.tsx](src/modeler/vpl/GraphEditor.tsx), cyan `#4cc9f0` / purple `#7e57c2`) are unchanged — those are sub-tab markers, not node colours.
- **Library agent models corrected to agents-only where the grid was dead weight**: 6 of the 8 shipped agent `.gcaproj` had `topologyMode.gridCells:true` but never used the lattice (empty cell graph, no field-bridge nodes, no `agentAccess` cell attrs) — flipped to `gridCells:false`: **Agent WASM Drift Test / Boids - Flocking / Game of Life on Agents / Morphogenesis - {3D, Differential, Growing} Tissue**. The two that DO use the grid as a morphogen field keep `gridCells:true`: **Ant Necrophoresis** (`corpse` field, `readCellsUnder`/`affectCellsUnder`) and **Chemotaxis - Aggregation** (`chemical` field, `secreteToField`/`fieldGradient` + a cell diffusion rule). The determinant of "uses the grid" is field-bridge node usage OR a cell attr with `agentAccess !== 'none'` OR a non-trivial cell graph. (Each flip is a one-line `gridCells` change, formatting preserved; the vestigial dead cell attr in each Tissue model + a dead A→C cell mapping in GoL-on-agents were left in place — invisible with the grid disabled, harmless.) Verified in-browser agents-only: Boids flocks (260 agents), Growing Tissue grows 12→24→48, GoL-on-agents steps to gen 653 (1024 agents), 0 errors.

### Graph-aware tag/own attribute resolution for universal nodes (bug fix)
Universal nodes (available on BOTH the Cells and Agents graphs) that resolve an OWN attribute (`attributeId`) or a TAG attribute (`tagAttributeId`) were resolving against raw `model.attributes` (cell attrs only), so on the **Agents graph** they couldn't see agent attributes — the Compare (`statement`) tag-attribute dropdown listed nothing usable, tag options came back empty, and Set/Update Attribute's inline value widget didn't even render. Two graph-aware scopes are the fix (both keyed on `getActiveGraphKind()`):
- **`ownAttrList`** (already existed for the config-UI attribute dropdowns) = `agents ? (model.agentAttributes ?? []) : cellAttrs`. Now ALSO used by the collapsed-label resolution for `getCellAttribute`/`setAttribute`/`updateAttribute` and by the **inline value-widget resolution** (`setAttr`) of the whole attribute-writer family — `setAttribute`/`updateAttribute`/`setNeighborhoodAttribute`/`setNeighborAttributeByIndex` (the functional bug: an unresolved attr gave `effectiveWidget = undefined` → no widget). `setNeighborhood*`/`setNeighbor*` are lattice-only, so the SAME graph-aware `ownAttrList` resolves the right attribute for every node type on whichever graph it renders — on the Agents graph the widget adapts to the AGENT attribute's type (bool→True/False, tag→named options, int/float→number, neighborIndex/color/vector→wired-only) with no compiler change (all three targets already coerce the stored `'true'`/`'false'`/tag-index).
- **NEW `tagAttrScope`** (a local next to `ownAttrList` in [CaNode.tsx](src/modeler/vpl/CaNode.tsx)) = `agents ? [...agentAttrs, ...cellFieldAttrsOf(model), ...modelAttrs] : model.attributes`. Tag pickers reference a tag attribute purely for its OPTION NAMES; the scope is every attribute whose DISCRETE value the active graph can read/compare. On the Cells graph this equals `model.attributes` (cell + model) so the `(model)`-suffixed dropdowns stay **byte-identical**. On the Agents graph it's the agent attrs + **agent-accessible CELL FIELD attrs** (`cellFieldAttrsOf` = `agentAccess` read|readWrite) + model attrs — the cell-field arm is load-bearing: when an agent samples/deposits a discrete cell field (`sampleField`/`readCellsUnder`/`affectCellsUnder`/`secreteToField`) it must be able to compare or produce that CELL attribute's tag value on the Agents graph. A cell attr with `agentAccess:'none'` is correctly EXCLUDED (the agent can't read it). Applied to the tag-attribute dropdown + option-resolution + collapsed label of `getConstant` (tag), `statement` (Compare tag), and `switch` (value+tag). Compilers are UNAFFECTED (they emit tag INDICES directly / read `_tagLen` from config — the agent compilers too), so this is a pure UI-resolution fix.
- **[nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts)** had the matching gap: `getConstant`/`statement` tag validation used `hasAnyAttr` (cell+model, no agent attrs) → a false "Select a tag attribute" badge for a valid agent tag attr. Replaced with a graph-aware `hasTagAttr`/`findTagAttr` over the same `tagAttrScope`; the now-unused `hasAnyAttr` was removed.
- Correctly LEFT as `model.attributes` (confirmed OK by the audit): `getModelAttribute` (shared model attr), `lookupInteraction`/`interactionTableMap` (lookupTable = model attr), and all lattice-only nodes (neighbour family, neighbourhood writes, `getNeighborAttributeByTag`, `filterNeighbors`, `moveSelfToNeighbor` — never on the Agents graph). Indicators/sprites/mappings/variables were already graph-correct.
- The audit (a fanned-out workflow) swept CaNode + nodeValidation + all 5 compilers + other UI; 13 CaNode sites + 2 nodeValidation sites fixed, everything else confirmed OK. Verified in-browser on a both-topology model: Cells-graph Compare lists `CellMode`+`A/B/C` (unchanged); Agents-graph Compare / Set Attribute / Get Constant list `AgentState`+`idle/active/dead`, the Set Attribute value widget renders, and no false validation badges appear. The **field scenario** was verified separately: a `Terrain` CELL tag field (`agentAccess:'read'`) + a `Hidden` cell tag (`agentAccess:'none'`) + an `AgState` agent tag — an Agents-graph Compare shows `AgState`+`Terrain` (NOT `Hidden`) and resolves `Terrain`'s `grass/water/rock` options; the Cells-graph Compare shows both cell tags.

### Field-bridge nodes gained their config UI (bug fix)
The 5 field-bridge nodes (`sampleField` / `fieldGradient` / `readCellsUnder` / `affectCellsUnder` / `secreteToField`) had **NO config UI in CaNode** (empty node body) and were **not** in `RELATED_NODES['cell-attribute']` — so a user could NOT pick the field's cell attribute (or the `reduce`/`op` mode) at all; the shipped Chemotaxis / Ant Necrophoresis models only worked because their generator scripts set `attributeId` directly. Since these nodes live on the Agents graph (where the Attributes panel lists AGENT attrs, not cell attrs), the field attribute MUST be picked in-node. Added a CaNode config block for the 5 types: a **"Field (cell) attribute…"** dropdown over `cellAttrsOf(model)` (ALL cell attrs — the nodeValidation badge then guides granting Agent access if the chosen attr isn't yet agent-accessible, matching the existing `hasCellAttr` → `hasFieldReadAttr`/`hasFieldWriteAttr` two-tier check) + a **reduce** dropdown (Mean/Sum/Max/Min) for `readCellsUnder` + an **op** dropdown (Set/Add/Subtract/Max/Min) for `affectCellsUnder`; plus a collapsed-label (`<Label> · <attr>`). `cellAttrsOf` (NOT graph-aware — field nodes always target cell attrs) is imported from [attributeScope.ts](src/model/attributeScope.ts). Verified in-browser: Chemotaxis' `fieldGradient`/`secreteToField` + Ant Necrophoresis' `readCellsUnder`(Mean)/`affectCellsUnder`(Add/Subtract) all show the right dropdowns with the shipped values, and a Mean→Sum edit round-trips through `updateConfig`. This complements the tag-scope fix above: together, an agent can now BUILD the whole field-interaction chain in the UI (pick the field attr on the read/write nodes, then Compare/Get-Constant its discrete cell value).

---

## 3D auto-zoom (the dolly sibling of auto-orbit)

Auto-orbit spins the camera; **auto-zoom** dollies it — and it has the SAME shape: it travels in ONE direction at the slider's rate (negative = zoom in, positive = zoom out, 0 = stopped) and **STOPS at the distance limit**, so it can't keep zooming forever. It is deliberately NOT an oscillation. The point is unattended recordings: start the camera close, turn both on, and it orbits + slowly pulls out as the model grows (the Softology Accretor videos).

- **The dolly is MULTIPLICATIVE** — `dist *= exp(speed * dt)` — so it reads as a constant-rate zoom at every distance (a linear `dist += speed*dt` would crawl when far out and lurch when close in). `speed` is therefore in **e-folds/second**: the default 0.15 pulls out from 1.9 to the far limit in ~20 s; the slider spans -1..1. Because `dist` is a **multiple of the largest grid dimension** ([gl3d.ts](src/simulator/render/gl3d.ts) `setCamera`), the motion is grid-size independent for free. The clamp to `[MIN_CAM_DIST, MAX_CAM_DIST]` IS the "limit" — no separate range control.
- **State**: `AutoZoom3D { on, speed }` + `DEFAULT_AUTOZOOM3D` in [gl3d.ts](src/simulator/render/gl3d.ts); `zoom3d` state + `zoom3dRef` in [SimulatorView.tsx](src/simulator/SimulatorView.tsx). **NOT persisted** — matching auto-orbit (a camera animation that resumed itself on every load would surprise), which also sidesteps the settings-persist **declaration-order trap** (any state feeding the persist effect must be declared ABOVE it, ~line 977).
- **A wheel zoom mid-flight COMPOSES for free** — the loop SCALES whatever distance the camera is at rather than SETTING it from a stored base, so a manual zoom simply carries on from where the user lands. (An earlier oscillating design needed a `zoomBaseRef` + `zoomPhaseRef` + an `autoZoomBaseFrom` re-baseline on every wheel/Reset to avoid stomping the user; the one-way dolly needs none of that. If you ever reintroduce an absolute `cam.dist = f(...)` form, that whole re-baselining problem comes back.)
- **ONE rAF loop drives BOTH animations** (the effect gate is `!is3D || (!orbit3d.on && !zoom3d.on)`) — two independent loops would each call `draw()` every frame and **double the redraw rate** when both are on. It reads its params through refs so a slider drag doesn't restart the loop; `last` resets to 0 while hidden so a tab-away can't apply a huge `dt` and fling the camera (the dt is also clamped to 0.1 s).
- **Shared camera consts** (same file): the distance clamp `MIN_CAM_DIST` (0.2) / `MAX_CAM_DIST` (40) and the default camera `defaultCamera3d()` are now exported consts/factory instead of literals duplicated between the wheel handler, the initial `cam3dRef`, and Reset view — so the wheel and auto-zoom **can't drift apart**. **Reset view now restores the default IN PLACE** rather than replacing `cam3dRef.current`, which used to strand every holder of the old object (the DEV `window.__sim3dCamera` hook among them — it reads a stale camera after a reset otherwise).
- Renderer-layer only: **2D untouched**, no compiler / worker / schema impact.
- **Verified in-browser** on Life3D. NB the Browser pane is **occluded** (`document.hidden`), which **suspends the real rAF** AND makes `readPixels` on the default framebuffer return all-zero — so drive the loop with an **rAF shim + synthetic timestamps**, and prove the render path by **spying on `Gl3DRenderer.setCamera`** rather than reading pixels. Results: at the default +0.15 the distance climbs monotonically 1.9 → 4.0 → 8.5 → 18.0 → 38.2 and **stops dead at 40**, staying there for another 20 s; at -0.3 it dollies in and **stops at 0.2**; speed 0 is stopped; a wheel zoom mid-flight applies (0.20 → 0.22) and the next frame **carries on inward from the new distance** (0.2199) instead of overriding it; with both animations on, **one rAF + exactly one `setCamera` per frame** (60 frames → 60 calls, 60 distinct distances reaching the renderer) while yaw spins and dist pulls out. Zero console errors.

---

## Quick-wins batch (branch `improvements`, 2026-07-27)

Nine small independent features/UX items from the TODO triage. All additive; the compiler changes are byte-identity-proven (`check-compile-identity` 25/25 unchanged) and the agent parity harness stays green.

- **Math node floor / ceil / round ops (all 5 emit surfaces)** — added to `arithmeticOperator` on JS cell ([ArithmeticOperatorNode.ts](src/modeler/vpl/nodes/ArithmeticOperatorNode.ts)), WASM cell, WebGPU cell, agentWasm, agentWebgpu (+ the CaNode op dropdown and `ARITHMETIC_UNARY_OPS`, which `hiddenPorts` + the collapsed label consume). **The parity rule: `round` emits `floor(x + 0.5)` on EVERY target** — never JS `Math.round` / WASM `f64.nearest` / WGSL `round()` (banker's rounding diverges on .5 cases) — the SAME convention the Expression node's `round()` already used (its emitters were the reference; no Expression change was needed, `floor/ceil/round` were already there). floor/ceil use native intrinsics (WASM opcodes 0x9C/0x9B — no new host imports; `OP_F64_CEIL` added to the wasm + agentWasm import lists). No `trunc` — the op set deliberately mirrors the Expression function set. Verified by [scripts/test-math-int-ops.mjs](scripts/test-math-int-ops.mjs): JS + a REAL instantiated WASM module in Node produce the hand-computed values (incl. round(2.5)=3, round(−2.5)=−2) bit-identically; WGSL emit checked for `floor(`/`ceil(`/the `floor(x + 0.5)` form and the ABSENCE of `round(`.
- **Lookup-table random-fill Min for Integer/Tag values** — `tableRoll.min?` ([types.ts](src/model/types.ts)) + `TableFillPolicy.intMin?` ([variegation.ts](src/modeler/vpl/compiler/variegation.ts) `randomFillTableData`): integer/tag entries draw uniform over `[intMin, valueCount]`; **absent (or 1) ⇒ bit-identical to the historical `1 + floor(next()*count)` draw** (same single RNG advance, proven in the extended [scripts/test-ndtable.mjs](scripts/test-ndtable.mjs) — old seeds keep reproducing their tables). With a min the raw (unclamped) max is used, so negative integer ranges (−5..−2) work; degenerate min > max collapses to min; tag min is an option INDEX (0 admits the "empty" option 0 into rolls). Editor: a Min `NumberField` in [LookupTableEditor.tsx](src/modeler/panels/LookupTableEditor.tsx)'s Randomize block for integer AND tag (integer Max lost its ≥1 clamp); the roll stores `min` (integer + tag). The Overseer `ovRandomizeTable` dep in SimulatorView passes `intMin: attr.tableRoll?.min` so a runtime re-roll reproduces the editor's policy.
- **Set Agent Sprite `setAlpha` facet** ([SetAgentSpriteNode.ts](src/modeler/vpl/nodes/SetAgentSpriteNode.ts) + the CaNode checkbox): writes the agent COLOUR's alpha byte `colors[_t*4+3]` (Uint8ClampedArray clamps) — the same alpha the sprite render already multiplies by, so it fades/hides sprites per agent with zero new SoA/ABI; a later colour pass (agent OM) overrides it, documented in the tooltip/Help. Emitted on all three agent targets like the other facets (the alpha byte lives in `colors`, which is allocated everywhere; on the GPU it is a packed read-modify-write of `agentColors[t]`).
- **Browser back exits the macro view** ([GraphEditor.tsx](src/modeler/vpl/GraphEditor.tsx)): one same-document `history.pushState` entry per macro level, RECONCILED from `currentScope` in an effect (enter pushes; a UI exit — breadcrumb/Undo Macro — consumes entries via one `history.go(delta)` with a `suppressPopRef` token so its popstate doesn't double-exit); the `popstate` listener pops exactly one level when inside a macro (decrementing `historyDepthRef` BEFORE the scope change so the reconcile effect no-ops) and no-ops at root (normal history behaviour). Orphaned entries after an unmount mid-macro are harmless (same-document state pops the app ignores); a remount re-pushes for the restored scope.
- **Renameable reroute labels** ([RerouteNodeComponent.tsx](src/modeler/vpl/RerouteNodeComponent.tsx)): the node context menu's Rename already worked for reroutes (`data.label`, wholesale-serialized) — the label just wasn't RENDERED. Now a small muted `.label` pinned above the dot (pointer-events none; `.reroute` gained `position: relative`), shown when non-empty; the tooltip carries it too. **A NEW reroute defaults its label to the relayed PORT's name** (`defaultRerouteLabel` in [GraphEditor.tsx](src/modeler/vpl/GraphEditor.tsx), applied by both creation paths via `makeRerouteNode`'s optional label param): a reroute of a reroute inherits THAT reroute's (possibly user-renamed) label, and an UNNAMED upstream reroute is walked past to the original port (cycle-guarded). Verified in-app: `Get Cell Attribute.value` → reroute labeled "Value", chained reroute inherits it.
- **Collapsible Properties sections** (now the `Section` primitive in [propertiesWidgets.tsx](src/modeler/panels/propertiesWidgets.tsx), used by every Properties sub-tab and the Indicators panel — the original was `CollapsibleSection` in PropertiesPanelContent, with `.sectionTitleCollapsible`/`.sectionChevron` in PanelContent.module.css): sections collapse via their title row (chevron). Collapsed bodies stay **MOUNTED** (`display: none`) — the Indicators list is a controlled master-detail child whose selection/effects must not reset. Persisted as a string[] in `localStorage['genesisca_properties_collapsed']` keyed by stable ids. `IndicatorsPanelSection` gained a `hideTitle` prop (the wrapper renders the title; `bare` variant avoids double `.section` chrome).
- **FPS / Gens-per-Frame popup sliders** ([SimulatorView.tsx](src/simulator/SimulatorView.tsx) + `.speedPopup*` css): the inline transport sliders became compact readout BUTTONS ("FPS 60" / "G/F 1") opening a small popover with a VERTICAL slider (a rotated horizontal range in a fixed wrap — robust vs writing-mode/orient) + the value + the ∞ checkbox. **Opens on HOVER of the wrapper too** (pointerenter/pointerleave; the popover sits FLUSH above the trigger — `bottom: 100%`, NO gap, because enter/leave are DOM-tree based and a visual gap is a hit-test hole that fires pointerleave crossing into the popover) and click still toggles. **Interacting with the slider while ∞ is ticked UNTICKS it** (the slider is never disabled — grabbing it means "I want this value"). One popover at a time (`speedPopup` state); dismissed by leave, capture-phase outside pointerdown, or Escape (capture + stopPropagation so Esc doesn't fire the simulator's reset). Everything carries `data-sim-overlay`. Value semantics/persistence unchanged; the orphaned `.transportSpeedLabel`/`.transportSlider` css was removed.
- **2D axes indicator** (SimulatorView `show2dAxes`, persisted in `genesisca_sim_settings`; a `⊾` toggle next to gridlines, 2D only): draws the grid ORIGIN (cell 0,0) dot + growth axes in `draw()`'s 2D branch — columns red → right, rows green → down — **matching the 3D axes convention**, primary tile only in infinity mode. Each axis spans the **FULL grid edge** with an arrowhead and a `C (n)` / `R (n)` label carrying the dimension count (dark-halo text, tip-anchored INSIDE the grid so it stays on-screen), and the block sits **AFTER the agent drawing** (drawAgentsOverlay / the A1 direct-render blit / the E2 composite blit) so nothing covers it. The state's sync effect also calls `draw()` (the onClick's own draw runs before the ref sync — the toggle must land while paused).
- **2D smooth scaling / anti-aliasing** (SimulatorView `smoothScaling`, persisted in `genesisca_sim_settings`; a `≋` toggle in the zoom cluster, **default OFF**): sets `ctx.imageSmoothingEnabled = true` **SCOPED to the grid blit only** in `draw()`'s 2D branch (and restored right after), so glyph tiles / sprites / gridlines / the cursor overlay keep the crisp default. **It works on BOTH grid blit paths for free** because they share ONE `drawImage(blitSource, …)`: `blitSource` is always a **GRID-RESOLUTION** canvas — the CPU `srcCanvas`, the glyph-fallback canvas, OR the **WebGPU direct-render OffscreenCanvas** (allocated `gridWidth × gridHeight`, so the display upscale happens on the main thread there too). `renderSimulationFrame` (the simulation-scope screenshot/recording render) honours it the same way, so a capture matches what the user sees. **Default OFF ⇒ byte-identical to the historical nearest-neighbour blit.**
  - **IT IS DELIBERATELY GRID-ONLY, AND THERE IS NO AGENT COUNTERPART.** Agent BODIES are antialiased **unconditionally on every path** (Canvas2D coverage on the CPU overlay; `fwidth` edge coverage in the GPU disc shader — see "THE DISC EDGE IS ANTIALIASED" in the direct-render section), so an agent toggle would have nothing to switch off and would be exactly the inert control the "AN ENABLED CONTROL MUST DO SOMETHING" rule forbids. The button's copy therefore names the GRID ("Smooth grid scaling") and states that agent bodies are always smooth — the earlier generic "anti-aliasing" wording sent users looking for an agent option that does not and should not exist.
  - **The toggle is HIDDEN, not disabled, where the main thread doesn't do the upscale** (the standing "no visible-but-inert options" rule): `!is3D` (3D renders through gl3d, whose WebGL2 context is already created with `antialias: true` MSAA — there is no 2D blit to smooth), `gridCellsOn` (an agents-only model has no grid layer), and `!compositeGridActive`. That last one is a **React state mirror of `agentCompositeActiveRef`**, assigned in the SAME statements as the ref (the mirror-invariant discipline) — the E2 composite draws the grid layer **in the worker at DISPLAY resolution with a NEAREST sampler**, so a main-thread smoothing flag structurally cannot reach it. A grid+agents model on the NON-composite path (e.g. Ant Necrophoresis, WASM/WASM) still shows the toggle.
  - **Verified with pixel histograms of the display canvas** (a 2-colour Game of Life zoomed in is the discriminating fixture — an intermediate value can ONLY come from interpolation): AA off → **2 distinct R values, 0 intermediate**; AA on → **256 distinct, 87 077 intermediate**; off again → the histogram is **exactly** the baseline. Identical numbers on the **WebGPU direct-render** grid and on the **WASM** grid (CPU `srcCanvas` blit).
- **3D axes follow-ups** (feedback round): (1) **agent-sphere FREE mode never drew the scene wireframes** — `overlaysOnly` skipped `renderOverlays` unconditionally, but only the L1 VOXEL free mode has a worker line pass drawing them; the agent-sphere free mode (Particle Life 3D) lost axes/grid/bounds entirely and they "appeared only on interaction" (the frame-mode pin). Fix: `setOverlaysOnly(on, wireframesExternal)` ([gl3d.ts](src/simulator/render/gl3d.ts)) — gl3d keeps drawing the wireframes in overlays-only mode unless the worker owns them; `draw()` passes `wireframesExternal = voxelFree` only. Structurally verified: agent-free draws, voxel-free skips, frame draws (2× — colour + the agentsInFront depth-restore). (2) **Axis extension + arrowhead now SCALE with the grid** (`ext = 1.2 + maxDim*0.02`, `hl = 0.7 + maxDim*0.025`) — the fixed 0.7-cell arrowheads were invisible at 300³. Mirrored byte-identically in gl3d `renderOverlays`, `renderAxisLabels`' ext, AND the worker's `buildVoxelOverlayVerts` ([webgpuRuntime.ts](src/simulator/engine/webgpuRuntime.ts)) — the free/frame flip must not move the axes. (3) **The 3D axis tip labels now carry the C/R/D LETTER + the count** (`C 300`): `pushDigitsNdc` renders GLYPHS letter polylines alongside the 7-segment digits.
- **Compile-target chip** (SimulatorView stats overlay): shows the RESOLVED targets — grid (`WebGPU`/`WASM`/`JS` from properties) + `agents …` (via `agentTargetOf` + the two agent gates, **memoised on [model]** — the gates flatten the agent graph, too costly per stepped re-render); agents-only models hide the grid part. Honesty arm: the `useWebGPUStatus` handler records `ready:false` while WebGPU is enabled → the chip turns amber `WebGPU✗` (device/init failure fallback).
- Docs synced: HelpView (Math ops, Randomize Min, sprite alpha facet, transport popovers, axes+chip, reroute rename, macro back), README (transport line), NODES_REFERENCE (Math row #36 + Set Agent Sprite row #115, which also caught up on the rotation/scale facets).
- NOT done from the quick-wins list: "make app open full-screen" — deferred pending clarification (browser fullscreen is user-gesture-gated; PWA/Tauri window config is a different feature).

---

## Medium-features batch (branch `improvements`, 2026-07-28 — five features, one commit each)

The "handoff" batch (the spawned agent hit the session limit, so it was implemented inline). All additive; harnesses green per feature.

- **Simulator Instructions** (`59f12f1`): `ModelProperties.instructions?` (additive) — a multiline "Simulator Instructions" textarea in the Info panel; when non-empty the Simulator shows an **ⓘ Instructions** pill (top-left, `left: 36px` clear of the panel-expand ear) opening a dismissible `pre-wrap` card (`.instructionsBtn`/`.instructionsPopover` in SimulatorView.module.css; capture-phase outside-pointerdown + Esc-with-stopPropagation dismissal; closes on model load, keyed on `properties.name`). The standalone viewer's About panel renders it too. The pill+card share a `display: contents` wrapper ref so the outside-dismiss treats them as one region.
- **Preset export/import `.gcapreset`** (`4351101`): [fileOperations.ts](src/model/fileOperations.ts) `PresetFile` (`{schemaVersion: 1, name, description?, preset}`) + `downloadPresetFile`/`readPresetFile` (Tauri Save-As via saveTextFile; import regenerates the preset id, normalizes embedded-state depth like readStateFile, accepts a bare Preset object). The preset object travels VERBATIM so the documented load semantics (grid-carrying = dims-authoritative, parameter-only = grid-less) are preserved exactly — and, being verbatim, it carries the `agents` payload for free (verified: a `.gcapreset` round-trips the agent population, and the embedded `model.presets` in a `.gcaproj` do too via `stringifyCompact`'s whole-object walk).
- **Preset section UI — the three title-bar icons + the export-current shortcut (`tasks_batch_2026_08`):** the simulator Presets section title (`styles.sectionTitleRow`) carries three right-aligned icon buttons (`styles.titleIconBtn`) — **add** (`+` → `setPresetDialogOpen` = the PresetSaveDialog), **import** (download SVG → `presetFileInputRef.click()`), **export** (upload SVG → `setPresetExportDialogOpen`). These REPLACED the two full-width "+ Save Current as Preset…" / "Import Preset…" buttons that used to sit below the list (the hidden `presetFileInputRef` picker stays). **Export current as preset** is a NEW feature: `handleExportCurrentAsPreset(name, desc, includeGrid)` runs the SAME `getState`→`serializePreset` capture pipeline as `handleCreatePreset` but calls `handleExportPreset` (downloadPresetFile) INSTEAD of `addPreset` — so the current state goes straight to a `.gcapreset` file WITHOUT being added to the model's presets (the "just save a file locally" shortcut). It reuses a SECOND `<PresetSaveDialog title="Export Current as Preset" confirmLabel="Export Preset">` gated on `presetExportDialogOpen`. Both import + export-current are ALSO reachable from the transport bar's Import/Export menus (above). A per-preset-ROW `⤓ Export` (in the row's `…` menu) still downloads that ALREADY-SAVED preset.
- **Drag-and-drop onto the app** (`14a6495`): window-level dragenter/dragover/dragleave/drop in [App.tsx](src/App.tsx) (preventDefault so the browser never navigates; a counter-based `dragActive` full-window overlay). Routing by extension: `.gcaproj`/`.json`/`.html(.htm)` → the FileMenu/PWA-file-handler load flow (readModelFile + the `pendingLibLoad` unsaved-changes ConfirmDialog + `afterLoad`); `.gcastate` → a "Replace the simulation state?" ConfirmDialog then the transport-bar Load State path via a **`genesis-load-state-file`** CustomEvent; `.gcapreset` → **`genesis-import-preset-file`**; **`.gcamacro` → the graph editor's macro import (2026-08-25)** — routed through THE one import path the canvas "Import Macro…" menu uses (`importMacroFile` in GraphEditor: `parseMacroFile → planImport → the M2 resolution dialog when references need decisions, straight through when not`). The editor is UNMOUNTED on non-Modeler tabs, so the file rides a module-level `graphState.ts` slot (`setPendingMacroImport`/`hasPendingMacroImport`/`takePendingMacroImport`) that survives the App.tsx tab switch to the Modeler; GraphEditor drains it from a `genesis-import-macro-file` listener AND on mount — **peek-then-consume with a ~40-frame retry**, because on a fresh mount React Flow hasn't measured yet and consuming early dropped the macro at flow (0,0). Drop coords are honoured only when the Modeler was already active AND the drop landed on the canvas; else viewport centre; images → **`genesis-open-image-file`** (the Ctrl+V clipboard seam into the Map Image to Cells dialog); **`.csv`/`.tsv` → `genesis-open-csv-file`** (the Import CSV dialog — see its own section). SimulatorView consumes the four events in one latest-ref effect. `handleDroppedFile` goes through a latest-ref so the once-registered listeners never act on stale closures.
- **Agent copy/paste** (`71a4501`, **2D + 3D**): Ctrl+C/X with the AGENT brush target collects the footprint ids and batch-reads their FRESH spec via a new **`readAgents`** worker message (which JOINS the one-shot staleness READERS beside getAgentState — a free-mode copy is never stale); the `agentsRead` reply stashes relative-to-anchor specs (position/radius/velocity/attr values) in `agentClipboardRef`; cut kills the sources only after the read captured them. Ctrl+V posts a new **`pasteAgents`** message with PER-AGENT specs (unlike seedAgents' shared sets), composed from `allocAgentSlot`/`initAgentSlot`/`applyAgentSets` (the compiled-fn ABI + SoA layout untouched), wrapped/clamped per axis, `agentOverflow` on capacity. `pasteAgents` is in `AGENT_GPU_DEFER_TYPES` (deferral + residency re-upload for free). Verified through the real worker: bit-exact velocities/positions; per-agent attr sets proven with an inverted-value paste on GoL-on-agents.
  - **2D** anchors on `agentCursorWorldRef` and takes the `agentsInShapeAt` footprint (hovered-agent fallback). **3D anchors on the BRUSH-PLANE cursor** (`hover3dRef`, the cell-clipboard rule — plane disabled or no hovered cell ⇒ **no-op + the SAME hint toast**, never a write), takes the VOLUMETRIC `agentsInShape3dAt` footprint (so what the hover rings highlight is what gets copied) and falls back to **`nearestAgent3dAt`** — the 3D sibling of `pickAgentAt`'s "nearest within its own radius" rule, derived from the plane cell because *the keyboard has no cursor coordinates* and gl3d's colour-id pick needs them. The agent world IS the grid frame 1:1, so the anchor cell's `col/row/layer` ARE world `x/y/z`.
  - **ONE clipboard serves both dimensions — 2D is the `dz`/`vz` === 0 case** (the unified cell-clipboard rule). A 2D copy pasted in 3D lands as a FLAT slice on the anchor's plane layer; a **3D copy pasted into a 2D model FLATTENS** for free, because `pasteAgents` applies `z`/`vz` only when `worldDepth > 1` — so the paste always ships them and there is no second code path. Cross-model attribute mismatches are skipped by `applyAgentSets`' `if (r)` guard (unchanged 2D behaviour).
  - **The WORKER was already fully 3D-capable** (`readAgents` returns z/vz at depth > 1; `pasteAgents` writes them with the wrap/clamp discipline) — the whole gap was the main thread, where the 3D keydown arm **returned early for the agent brush target** (a completely silent no-op: no message, no toast) and the clipboard stash dropped z/vz. So the fix needed **no worker-protocol change**.
  - **A 3D copy TOASTS its count** (`Copied 179 agents`) — the volume is occluded and may reach deeper than the plane, exactly the reason the 3D cell copy toasts; 2D stays silent (the cursor ring already shows the footprint) and paste is silent in both.
  - **Neither BONDS nor SPRITE state travel** (`readAgents` returns position/radius/velocity/attributes, and `initAgentSlot` forms no bonds) — pasted agents arrive unbonded. Documented, not a defect.
  - **Verified through the real worker on both agent targets**: **Particle Life 3D (WebGPU agents, torus)** — 57 agents copied at one plane cell and pasted at a different layer/row/col reproduced the cluster with **max error EXACTLY 0** on x/y/z/radius/vx/vy/vz and 0 attribute mismatches, all 44 non-wrapped agents sharing the exact anchor delta `(-50,-35,-23)` while **13 crossed a torus seam** and still landed exactly; **cut** removed exactly the 124-agent footprint (liveCount delta 124, 0 survivors, 0 collateral, kill ids ≡ read ids) and the cut clipboard pasted all 124 back; **a copy taken WHILE FREE-RUNNING matched the post-pause truth exactly (error 0) against a 0.92-unit pre-play snapshot** — the one-shot staleness read proven, not assumed; overflow capped at exactly maxAgents 2400 with the notice. **Morphogenesis — 3D Tissue (WASM agents, CONSTANT boundary, bonded)** — 5 agents pasted at a corner matched the expected clamp-to-`[0,200]` values exactly with 3 agents clamping to 0 (the clamp arm, not a wrap), and the pasted agents carry `bondCount 0` while the sources keep theirs. Interop both ways (2D→3D lands at exactly the anchor layer; 3D→2D keeps the rigid xy shift 88/88 and reports no z). Regressions: 2D agent copy/paste unchanged (25/25, rigid shift, 6e-6 f32 error) and the 3D CELL clipboard still byte-exact (196/196 cells on the Accretor). 0 console errors.
- **Hemifield / vision-cone display** (`afe3d02`): a **Show vision** selector (Off / Inspected agent / All, persisted as `showVision` in `genesisca_sim_settings`) in the 2D agent controls, rendered only when the agent graph (top-level + macro internals) contains an FOV node. The `visionCones` `useMemo([model])` extracts per-node halfAngle/radius (inline `_port_radius` when unwired, else the `neighbourQueryRadius` fallback — a wired radius isn't knowable at render time). draw() renders translucent wedges (velocity heading; zero heading or halfAngle ≥ 180° → full circle, matching the nodes' omni rule; Facing/Wired heading sources approximated by velocity — documented; All capped at 1500; one tint per node). **`updateAgentUiSync` gained a want-term while not Off** (the cones read the agent snapshot, which free-running direct-render models don't ship).

---

## Panel resize responsiveness: the canvas re-sizes DURING the drag (2026-08-05)

**The bug (user-reported):** *"Resizing the side panels distorts the canvas, shrinking it, and it remains like that until some interaction with the canvas area triggers a refresh."* **`draw()` is the ONE place that re-sizes every backing store** (2D `canvas.width = parentW` + the two cursor overlays, gl3d's `r.resize(cssW, cssH, dpr)`) **AND does the direct-render OffscreenCanvas re-attach** — but it only ran on **step messages, canvas interactions and WINDOW resize** ([SimulatorView.tsx](src/simulator/SimulatorView.tsx) `window.addEventListener('resize', draw)`). A side-panel **splitter drag** mutates `panel.style.width` directly (no React update, no window resize) and a **panel/bar collapse** is a React state change nothing was listening to — so the canvas's CSS box grew/shrank while the backing store kept its old dimensions and the browser stretched the stale bitmap. On a **PAUSED** sim that was indefinite. **Reproduced before fixing** (real app, Game of Life, paused): collapsing the settings panel took `canvasArea.clientWidth` 980 → 1180 while `canvas.width` stayed **980**, and nothing else in the app ever corrected it.

**THREE triggers, all funnelling into one redraw** — deliberately not ResizeObserver alone, because RO delivery is part of the browser's rendering steps and (1)+(2) are the paths that must be immediate:
1. **`useLayoutEffect` on `[visible, leftPanelOpen, rightPanelOpen, topBarOpen, bottomBarOpen, rightPanelTab]`** → a DIRECT `drawRef.current()`. A LAYOUT effect runs after the DOM mutation and **before paint**, so a discrete collapse/expand never shows even one stretched frame. It also **clears the drag deferral** (`layoutResizeUntilRef.current = 0`) — a drag that ends in a snap-close lands here and must not wait out the settle window.
2. **Both splitter `onMove` handlers** call `scheduleLayoutDraw()` — they mutate the DOM directly, so nothing else would ever fire.
3. **A `ResizeObserver` on `canvasAreaRef`** as the general catch-all (browser zoom, font metrics, devtools, future chrome). The observed element is the one `draw()` measures; the canvases are `width/height: 100%` inside it and it is `overflow: hidden`, so **they can never feed back into its size** (no observer loop).

**`scheduleLayoutDraw`** is rAF-coalesced (one draw per frame at most — exactly what a PLAYING sim already does) and **opens a `LAYOUT_RESIZE_SETTLE_MS`(140) window in `layoutResizeUntilRef`**, re-armed on every call, with a trailing `setTimeout` that closes it and draws once more.

### THE RE-ATTACH IS DEFERRED FOR THE DRAG, AND THE BLIT SCALES INSTEAD
A transferred OffscreenCanvas has **FIXED dims**, so tracking a drag exactly means one `transferControlToOffscreen` + one worker pipeline rebuild **per frame**. **MEASURED on Particle Life** (WebGPU agent target, direct render): a 30-move drag produced **26 `attachAgentCanvas` messages**. So all **four** re-attach sites in `draw()` (2D composite, 2D agent-direct, 3D sphere, 3D voxel) now additionally test **`!resizeAttachDeferred()`**, and the worker-presented canvas is kept looking right meanwhile:
- **2D**: both blits changed from `drawImage(src, 0, 0)` to **`drawImage(src, 0, 0, parentW, parentH)`** — a **no-op once the dims match** (the usual case), and while an attach is pending it keeps the live image filling the new box at the right aspect (momentarily soft) instead of letterboxing/clipping it. This also improves the pre-existing handshake gap the section above calls *"slightly mis-sized"*.
- **3D**: the sphere + voxel layers are already `width/height: 100%`, so CSS stretches them for free.

Result, measured on the same 30-move drag: **1 attach during the drag + 1 after the settle = 2** (was 26), with the display canvas matching the container at **every one of the 30 samples**. A snap-close gesture: **1** attach, final blit `src 1400×864 == dst 1400×864`.

### Verified (real app, real worker, real GPU)
Game of Life (2D, WebGPU grid): **paused** — all four collapse/expand actions track exactly; **playing** — both splitter drags, 20 samples each, **0 mismatches**, sim advancing throughout. Life3D (3D): 5 toggles + an 18-sample playing drag, **0 mismatches** (`glCanvas.width == round(area.clientWidth × dpr)`). Particle Life (direct render): a 12-toggle + 3×25-move stress run while playing = **87 checks, 0 failures**, `directActive` never dropped, **15 attaches total** (~2.3 per drag gesture). The Modeler's React Flow canvas is untouched and resizes itself (1000 → 1320 on a panel collapse). **0 console errors** anywhere; `tsc`, `npm run build`, `verify-agent-render.mjs` and `check-compile-identity.mjs` (**29 models, all surfaces unchanged** — `git diff --stat` is SimulatorView.tsx only) all green.

**NB for future verification here:** an occluded Browser pane delivers **neither `requestAnimationFrame` nor `ResizeObserver`** callbacks (both are rendering-step work), so trigger (3) cannot be exercised there — drive (1) directly (React effects run regardless) and (2) through a MessageChannel rAF shim.

---

## LIVE mode — the simulator inside the split workspace (Phase 2, 2026-09-07)

**Live** is the third top-level mode (`Modeler · Simulator · Live`): the rule graph and the *running*
simulation side by side in two opaque panes divided by a draggable splitter. Design authority:
[docs/IMPACT_MAP_LIVE_SPLIT.md](docs/IMPACT_MAP_LIVE_SPLIT.md) + [docs/PLAN_LIVE_SPLIT.md](docs/PLAN_LIVE_SPLIT.md)
(Phase 2 = the mode, the dual mount, the layout; Phase 3 = the last-good-rule / apply policy;
Phase 4 = keyboard ownership, Overseer exclusion, perf guards). **Zero compiler/emit impact** —
`check-compile-identity`: 31 models, all surfaces unchanged.

### ⚠ THE MOUNTING INVARIANT — `SimulatorView`'s POSITION IN THE REACT TREE IS IDENTICAL IN `simulator` AND `live`

`SimulatorView` owns the Web Worker, the WASM memory, the WebGPU device, the agent SoA snapshot and the
whole grid state. React reconciles by POSITION, so a Live-only wrapper around it would unmount + remount
it and the running simulation would be *gone* (generation 12 000 → 0). So [App.tsx](src/App.tsx) mounts
**both** pane wrappers in **every** mode — the modeler one is an empty `display: contents` div outside
Modeler/Live, which is free — and Live changes only `className` / `style`. The splitter is a Live-only
sibling BETWEEN them (`{cond && …}` renders null elsewhere and holds the slot). Dock-bottom / swap-sides
are therefore pure `flex-direction` on `.content` ([App.module.css](src/App.module.css) `.liveRight` /
`.liveBottom` / `.liveSwap` + `.livePane`); **no element ever moves**, which is why the layout menu costs
nothing. `min-width: 0` / `min-height: 0` on `.livePane` are load-bearing — without them a flex item will
not shrink below its content and the splitter jams. **Measured:** entering Live from a Simulator run at
gen 808 kept the counter climbing (940 four seconds later) with `window.__simWorker` the *same object
identity*, across Simulator ⇄ Live ⇄ Modeler ⇄ Library round trips.

### `visible` = SHOWN, `activeTab` = the active tab — the prop split

`SimulatorView({ visible, activeTab, live, hideInstructionsPill })`:

- **`visible`** keeps its name and means *"this view's canvas has a real, non-zero box on screen"* —
  true on the Simulator tab AND in Live. It is what `visibleRef` carries, i.e. what gates every draw
  outside the step loop (the 0×0 `drawImage` → `InvalidStateError` → React-unmount rule). It is FALSE
  while the Live viewport is collapsed.
- **`activeTab`** means *"this view IS the whole content area and owns the keyboard by default"* — true
  only on the Simulator tab. Defaults to `true` so the standalone viewer shell is unchanged. Phase 4's
  keyboard-ownership work is the other consumer.
- **`live`** drives the viewport bar, the panel policy and the overlay panel layout. It stays TRUE while
  the viewport is collapsed — that combination is what keeps the run going while the user works on the
  graph alone.

⚠ **The auto-pause arm is `else if (!activeTab && !live && playing)`**. `!live` is load-bearing: a
collapsed Live viewport makes `visible` false, and pausing there would defeat the mode. `activeTab` and
`live` are both in the effect's dep list. Everything else in that effect (the `refreshDisplay` /
`setGridCamera`+`refreshGridDisplay` / `setAgentCamera`+`refreshAgentDisplay` re-present block) keys off
`visible` and fires on Live-enter for free — entering Live is the same hidden-0×0 → real-box transition
the block exists for, and the 3D camera re-send it performs is what stops a `refresh*Display` presenting
the OLD view.

### THE `simLayoutApi` SEAM — the Live splitter is OUTSIDE `SimulatorView`

[src/simulator/simLayoutState.ts](src/simulator/simLayoutState.ts) is a module global registered by
`SimulatorView` on mount and nulled on unmount (the `quickAddApi` pattern): `{ scheduleLayoutDraw, drawNow }`.
The Live splitter is a sibling in `<main>`, so it can reach none of the three existing resize triggers.

- `onPointerMove` → `simLayoutApi.scheduleLayoutDraw()` (rAF-coalesced draw **plus** the 140 ms
  `layoutResizeUntilRef` window that holds off the `OffscreenCanvas` re-attach).
- `onPointerUp` and every layout-menu action → `simLayoutApi.drawNow()` = *clear the deferral, then
  `drawRef.current()`* — the same two statements the panel/bar `useLayoutEffect` performs. `App` also
  runs a `useLayoutEffect` on `[mode, dock, swapped, split, viewportCollapsed]` that calls `drawNow`, so
  a discrete change repaints before paint.

⚠ **Relying on the `ResizeObserver` catch-all alone is the documented failure**: RO delivery is part of
the browser's rendering steps, an occluded pane delivers none, and without the deferral window the drag
drives one transfer + one worker pipeline rebuild per frame. **Measured over a 30-move Live splitter
drag: 1 `attachAgentCanvas` (Particle Life, GPU-resident direct render), 1 `attachAgentCanvas`
(Chemotaxis, E2 composite), 2 `attachVoxelCanvas` (Life3D)** — against 26 for the unguarded case — with
`canvas.width === canvasArea.clientWidth` (×dpr in 3D) at **every one of the 30 samples, 0 mismatches**.

⚠ **The splitter mutates the two panes' inline `flex` DIRECTLY during the drag** and only COMMITS the
fraction to `liveUiState` on release — the discipline the simulator's own side-panel handles use. Routing
every `pointermove` through React state would re-render both views tens of times a second. Its
`pointermove`/`pointerup` listeners are on **`document`**, not on the 6 px handle: `setPointerCapture` is
best-effort (`tryCapture`), and without capture a handle-scoped listener stops firing the instant the
cursor leaves the bar.

### Live layout state — `genesisca_live_layout`, a FRACTION, and why it is not `genesisca_sim_settings`

[src/live/liveUiState.ts](src/live/liveUiState.ts) is a module global + pub/sub with localStorage
write-through under **`genesisca_live_layout`**:
`{ dock: 'right'|'bottom', swapped, split (0–1, the GRAPH pane's share), viewportCollapsed, applyPolicy }`.

- A **fraction, not pixels** — it survives a window resize and a dock flip with no re-clamping. Clamped to
  `[0.15, 0.85]`; double-clicking the splitter snaps to 0.5.
- **NOT `genesisca_sim_settings`**: that key is owned by `SimulatorView`'s single 300 ms persist effect
  whose declaration-order trap requires every persisted state to be declared above it. Live layout is
  App-level state.
- **The panel widths still do NOT persist** (both `PanelShell` and the simulator's own handles mutate
  inline `style.width` on an element that is unmounted on close) — that is *why* Live needed its own
  store rather than a pattern to copy.
- `applyPolicy` is stored but has **no control yet**: Phase 2 does not change the edit→rule pipeline, so
  an enabled Auto/On-demand switch would be internally inert — exactly what the UI doctrine forbids.
  Phase 3 lands the behaviour and the control together. Same for the transport chip.

### ⚠ COLLAPSE IS `display: none`, NOT A ZERO-WIDTH FLEX ITEM

`canvas.parentElement?.clientWidth ?? 500` returns **0**, not the fallback, for a 0-width pane — so
`canvas.width = 0` and the next `drawImage` throws `InvalidStateError` and unmounts React. A collapsed
Live viewport therefore uses `display: none` (with `visible` false), the proven-safe hidden state this
always-mounted view already lives in on every other tab. The splitter is HIDDEN while collapsed (there is
nothing to divide) and `LiveSplitter` renders a **restore ear** in its slot instead — the menu item is
collapse-ONLY, because the viewport bar lives INSIDE the pane it collapses and could never offer the
inverse.

### The Live viewport bar and the panel policy

- [src/live/LiveViewportBar.tsx](src/live/LiveViewportBar.tsx) renders **inside `.canvasArea`**, from
  `SimulatorView`, and carries `data-sim-overlay` — mandatory, or a click on it falls through the overlay
  guard and paints the grid. It is anchored **top-RIGHT** (the author-instructions pill already owns
  `left: 36px`). It holds the Settings / Controls panel toggles and the layout menu
  (dock right · dock bottom · swap sides · collapse viewport).
- ⚠ **The 3D View panel is the one other top-right overlay** and it collided with the bar (measured:
  bar `44..72`, panel `48..491`). Its inline `top` is now `live ? 44 : 12`. Anything new anchored
  top-right in `.canvasArea` has to make the same allowance.
- **The simulator's two side panels FLOAT over the canvas in Live** (`.liveOverlayPanels` modifier on
  `.simulatorLayout` → `position: absolute` on `.sidePanel` / `.rightPanel`). A 200 + 220 px pair would
  eat most of an already-halved pane; as overlays they behave as panel-sized popovers, which is how the
  brush, the layers matrix and the indicators stay reachable with the panels collapsed by policy.
- ⚠ **PANEL STATE MUST NOT LEAK INTO THE SIMULATOR TAB.** Both modes share ONE `SimulatorView` instance,
  so `preLivePanelStateRef` snapshots `{left, right, top, bottom}` on Live-enter and restores it on exit
  **including false entries** — the exact `prePanelStateRef` discipline. Verified: right panel closed in
  the Simulator, both opened inside Live, back to the Simulator ⇒ `{left: true, right: false}` again.
  (The bars are deliberately left open — the transport bar IS the transport.)

### Capture ↔ layout interlock

A `'view'`-scope recording pins the output frame dimensions on its first captured frame (`recordCropRef`
/ `recordDimsRef`) and drops every mismatched frame after that, so re-sizing the pane mid-recording
changes the source box while the frame size cannot follow. `SimulatorView` publishes `recording && live`
through [src/live/liveState.ts](src/live/liveState.ts) (`setLiveLayoutLocked`) and the splitter + every
layout-menu item **grey out in place with the reason** — the same disposition the existing "capture
settings while recording" rule uses, never a hide (stopping the recording is one click away). Capture
itself stays fully available in Live: the `'simulation'` scope renders the whole world at a fit framing
on the main thread, independent of zoom/pan and of the pane size.

### A pre-existing throw the Live splitter made unmissable

The 3D GL canvas's pointer effect registers `onUp` on **`window`**, and it called
`glc.releasePointerCapture?.(e.pointerId)` unconditionally — which **throws `NotFoundError`** for a
pointer that element never captured. So *every* pointer release outside the GL canvas (a transport
button, a panel splitter, the Live splitter) raised an uncaught exception while a 3D model was loaded.
Reproduced on the plain **Simulator** tab, i.e. it is not a Live regression. Now guarded with
`if (glc.hasPointerCapture?.(e.pointerId))`.

### Verified (real app, real worker, real GPU) — Phase 2

Game of Life (2D grid, WebGPU), Particle Life (2D agents, GPU-resident direct render), Life3D (3D voxel),
Morphogenesis — Growing Tissue (agents-only, no CA layer) and Chemotaxis — Aggregation (both topologies,
E2 composite): enter Live mid-run with the worker identity preserved and the generation counter climbing;
30-move splitter drags in both dock orientations with 0 canvas/container mismatches and ≤ 2 re-attaches;
dock right / dock bottom / swap sides / collapse / restore / double-click-snap; a reload restoring
`{dock: bottom, swapped: true, split: 0.30}`; a real graph edit (Get Random `bool → float` and back) while
playing → **2 `recompile` posts, generation 3933 → 4012 → 4091, same worker**; the recording interlock
locking and unlocking. **0 console errors throughout** (`window.onerror` + a `console.error` hook installed
before each reproduction). `tsc`, `npm run build`, `check-compile-identity` (**31 models, all surfaces
unchanged**), `verify-agent-render.mjs` and `parity-agent-wasm.mjs` all green.

**NB for future verification here:** React Flow node drags and the 3D orbit gesture cannot be driven by
synthetic pointer events (`setPointerCapture` throws for a pointerId the browser never issued, which
aborts the handler) — drive the pure state instead, or verify by measurement. The Live splitter *can* be
driven synthetically because its capture is wrapped in `tryCapture` and its move/up listeners are on
`document`.

---

## LIVE mode — the edit→rule PIPELINE (Phase 3, 2026-09-07)

Phase 2 put the graph beside the running simulation; the pipeline between them was still the Simulator
tab's. Phase 3 makes editing while it runs safe: a graph that does not compile keeps the **last good
rule** running, a **structural** edit asks before re-seeding the board, and the user can hold every edit
back until an explicit apply. All of it lives in `SimulatorView`'s model effect —
**`sim.worker.ts` has no diff, and no new worker message exists**.

### ⚠ TWO ERROR CHANNELS — `compileError` is NOT the compile channel

`compileError` is the simulator's **general** error surface: CSV / GeoTIFF / GeoJSON / preset import
failures, a CSV export failure, dimension-apply failures and the worker's own pushed `error` message all
land there, and only a handful of its call sites are graph compiles. **So "no red banner in Live" can
never be a blanket suppression** — it would silently swallow a failed GIS import (the user drops a
GeoTIFF, nothing happens, nothing is said).

The graph-compile result therefore has its own channel, `ruleState: { status, message }` with
`status: 'ok' | 'stale' | 'pending' | 'rebuild'` (`LiveRuleStatus`, declared in
[src/live/liveState.ts](src/live/liveState.ts)), rendered by the Live viewport bar's **transport chip**.
Two helpers are the ONLY writers, and every graph-compile arm goes through them:

- **`reportRuleCompile(message)`** — outside Live: `setCompileError(message)` exactly as before. In Live:
  clears `compileError` and sets the chip. ⚠ It **refuses to overwrite `pending` / `rebuild`** with
  "Synced": a compile can be triggered from outside the model effect (Apply dimensions, an image import
  → `initWorkerWithDimensions` → `compileModel`) while a deferral is still outstanding, and saying
  "synced" there would claim the worker has a model it does not have. The model effect clears the status
  itself the moment it commits to applying.
- **`appendRuleCompile(message)`** — the agent half, appended to the cell half (`[agents] …`).

The two render sites (`.errorBanner` over the canvas and the left settings panel's red block) are
**unchanged** — they still read `compileError`, which in Live simply never carries a graph-compile
message. **Switching to the Simulator tab with a broken graph therefore shows the red banner there**,
because leaving Live flushes the deferral and the same helpers route to the banner again.

### ⚠ LAST GOOD RULE = THE `recompile` POST IS WITHHELD, NOT RECOVERED FROM

`sim.worker.ts` does `stepFn = stepCode ? eval(stepCode) : null` (and the same for `agentBehaviourFn`),
and `safeCompileGraph` returns an EMPTY step on a throw. So a failed compile does not merely *show* an
error — **it replaces the running rule with nothing**. Right for the Simulator tab (the user asked to
recompile); fatal in Live, where a graph is half-wired dozens of times a minute.

The seam is on the **main thread**: when Live is shown and either half produced a compile error, the
soft-recompile arm **returns before posting anything** —

```ts
if (liveRef.current && ruleError) return;   // …and appliedModelRef does NOT advance
```

A message the worker never receives cannot change its `stepFn`, `wasmStepFn`, WebGPU pipeline or
`agentBehaviourFn`, so the last good rule survives *by construction*. That early return also skips the
`setUseWasm` / `setUseWebGPU` posts (they would flip the running engine off a broken compile), the
direct-render gate refresh and the indicator sync — everything past it is "the apply".

- **Both halves, one gate.** The cell error and the agent `[agents] …` error are accumulated into ONE
  `ruleError` local, so an agent-graph edit cannot null `agentBehaviourFn` while the cell rule keeps
  running (a half-frozen model reads as a bug, not as "stale").
- **`refreshShowCode` runs BEFORE the gate** — Show Code must reflect what the user is typing.
- The offending nodes' amber `!` badges are the existing `nodeValidation` mechanism; the chip's tooltip
  carries the compiler message.
- Recovery is automatic: the first error-free compile posts `recompile` normally and the chip returns to
  `● Synced`.

### ⚠ `appliedModelRef` — THE BASELINE `needsFullInit` IS COMPUTED AGAINST

`prevModelRef` is advanced unconditionally at the top of the model effect, so it answers *"what did the
previous render hold"*, not *"what is running"*. With a deferral in play that is the wrong question: the
next edit would compare the new model against the **already-changed** baseline, `needsFullInit` would
come back `false`, and the deferred rebuild would be silently lost — the worker running a layout the
model no longer describes, the exact baked-offset desync class the 25 comparisons exist to prevent.

So **`needsFullInit` is computed against `appliedModelRef.current` — the last model actually pushed to
the worker — and that ref advances ONLY inside the two branches that really push** (the full reinit and
the soft recompile, the latter *after* the last-good-rule gate). Consequences worth knowing:

- **N deferred structural edits cost ONE reset**, for free: every deferred edit keeps comparing against
  the same applied baseline.
- The `snapJustChanged` test and the `updateIndicators` "did the indicators change" test in the same
  effect were moved onto `applied` for the same reason — comparing against `prev` there would drop an
  indicator edit the worker never received.
- `handleRecompile` adopts the current model as the baseline and clears the chip (it IS an apply).
- A **model load / new model** must never sit behind a prompt: the effect compares `modelVersion` against
  `appliedModelVersionRef` and force-applies when it changed.
- **Leaving Live flushes**: if `appliedModelRef.current !== model` on the way out, the apply is re-run
  with `live` already false — so the Simulator tab is never silently running a stale rule, and its red
  banner appears if the graph is broken.

### Apply policy — Auto vs On demand, and `Ctrl+Enter`

`liveUiState.applyPolicy` (persisted in `genesisca_live_layout`) is edited by a two-button segment on the
Live viewport bar. **Auto** is today's behaviour. **On demand** holds the *model→worker* step: the model
effect returns early with `status: 'pending'` and `Ctrl+Enter` (or the chip's **Apply**) re-runs it.

⚠ **`scheduleSync` is deliberately NOT what is held.** It also feeds undo/redo, the macro write-back and
the dirty flag; holding the graph→model step would break all three. Holding the model→worker step keeps
the Modeler fully live and only the *simulation* behind.

The apply mechanism is an `applyNonce` in the model effect's dep list plus a one-shot
`liveApplyForceRef`: one bump = one apply, whatever was queued.

⚠ **The `Ctrl+Enter` stand-down set is narrower than the usual field check** — only `TEXTAREA` and
`contentEditable`. A `<select>` KEEPS FOCUS after the user picks an option, and picking an option in a
node is the commonest way to make the edit you then want to apply; standing down there would make the
shortcut do nothing exactly when it is most wanted. `Ctrl+Enter` has no native meaning in a `<select>` or
a single-line `<input>`, so nothing is stolen. The capture-review modal still wins.

### The structural-rebuild prompt

`needsFullInit` in Live sets `status: 'rebuild'` instead of terminating the worker. The chip reads
`⟳ Rebuild needed` and offers **Apply** / **Later**; **Later** collapses the prompt to the bare chip
(clicking the chip brings the buttons back) and changes **nothing** about the deferral, which lives in
`appliedModelRef`. The Apply tooltip names what comes back — resolved from `resetDefaultMode`
(`resetRestoresBoard` + `savedBoard`), the one resolver, as *"the saved board"* or *"a fresh seed from
the Init Events"*.

### UI-doctrine disposition (Phase 3 controls)

| Control | Disposition |
|---|---|
| Transport chip | **only exists in Live** — the Simulator tab's surface for a compile error is the red banner, so a chip there would be meaningless rather than unavailable (hide, not grey) |
| Chip **Apply** | rendered only in `pending` / `rebuild` |
| Chip **Later** | rendered only in `rebuild` (a `pending` queue is already "later" by definition) |
| Apply-policy switch | always enabled, Live only |
| Red compile banner | unchanged code; in Live it simply never receives a graph-compile message — import / export / worker errors still raise it |

### Verified (real app, real worker, real GPU) — Phase 3

**Game of Life (2D, WebGPU)** — unset the `Get Cell Attribute` attribute mid-run: generation kept
climbing **4400 → 5354**, chip `● Stale`, the amber `!` badge on the node (`Select an attribute`),
**0 `recompile` posts**, no red banner; re-selecting it posted **exactly 1** `recompile`, chip back to
`● Synced`, **same worker object**. The new rule really takes over: deleting the `Generation Step → If`
edge (which compiles cleanly to an empty step) posted one `recompile` and the board **froze — identical
FNV pixel hash across 1.5 s — while the counter kept climbing**; restoring it resumed evolution.
**On demand:** three edits → `● Pending`, **0** posts; `Ctrl+Enter` (with a `<select>` focused) → **1**
`recompile`, `● Synced`. **Rebuild:** adding a cell attribute → `⟳ Rebuild needed`, **0 terminates**,
gen 3422 → 3509 still climbing; a second attribute → still one prompt; **Later** then a further
non-structural edit → still `rebuild`, still nothing posted (the Trap-C regression check); **Apply** →
**exactly one `terminate`**, gen 0. **Banner not over-suppressed:** dropping a malformed `.gcapreset`
while in Live raised *"Preset import failed: …"* on the red banner with the chip still `● Synced`.
**Simulator tab:** switching there with a broken graph flushed the deferral (1 `recompile`) and showed
the red banner; the chip is absent.
**Particle Life (2D agents, GPU-resident)** — deleting the **Behaviour Step** node gave
`[agents] No Behaviour Step node in the agent graph.`, chip `● Stale`, **0 posts**, and the **agents kept
moving** on the last good behaviour; `Ctrl+Z` restored it and the chip returned to `● Synced`.
**Life3D (3D voxel)** — the same last-good-rule result (chip stale, gen 554 → 606, 0 posts) and the same
rebuild prompt, applied with `Ctrl+Enter` → one `terminate`, gen 0, voxels rendering correctly.
**Debounce stretch, measured:** the identical edit took **270 ms** with the pointer released and
**568 ms** with a pointer held in the editor (Δ ≈ the 100 → 400 ms stretch); releasing 50 ms after the
edit collapsed it to **359 ms**, i.e. the release re-arms the short debounce.
**0 console errors throughout** (`window.onerror` + `unhandledrejection` + a `console.error` hook
installed before every reproduction). `tsc`, `npm run build`, `check-compile-identity --compare`
(**31 models, all surfaces unchanged**) and `parity-agent-wasm.mjs` all green.

---

## LIVE mode — INPUT OWNERSHIP and the perf guards (Phase 4, 2026-09-07)

Phase 2 put the two workspaces side by side and Phase 3 made editing while it runs safe. Phase 4 answers
the remaining question — **which surface does a keystroke act on** — and fixes **two pre-existing defects
that had nothing to do with Live** but that Live made unmissable. Plus the two perf guards.
**No compiler / emit diff, no worker diff:** `check-compile-identity` **31 models, all surfaces unchanged**.

### ⚠⚠ THE PRE-EXISTING BUG: the main keyboard handler was NEVER VISIBILITY-GATED

`SimulatorView` is **always mounted** (behind `display: none` on every other tab), so its
`Space · Enter · Esc · Backspace · Ctrl+C/V/X · 3D digits` handler ran **in the Modeler too**.
Measured on the pre-fix build, on the Modeler tab with Game of Life loaded:

| Key (in the MODELER) | Before | After |
|---|---|---|
| `Enter` | one `step` batch posted, **gen 250 → 251** | **0 posts**, gen unchanged |
| `Esc` | a `reset` posted, **gen → 0** | **0 posts**, gen unchanged |
| `Backspace` | same reset arm | 0 posts |
| `Space` | (safe only because `ModelerView` calls `stopImmediatePropagation`) | 0 posts |

The gate is three questions, in order — `visibleRef` (is this view on screen at all), then the Live focus
owner, then the one global-in-Live exception:

```ts
if (isTypingTarget()) return;              // INPUT / TEXTAREA / contentEditable
if (captureReviewRef.current) return;
if (overlayOwnsKeyboard()) return;         // any modal or open menu
if (inLive && Enter && (ctrl||meta)) return;          // that is Live's "apply now"
const globalLiveKey = inLive && e.key === 'Enter' && !e.altKey;
if (tag === 'SELECT' && !globalLiveKey) return;
if (!visibleRef.current && !globalLiveKey) return;
if (inLive && !globalLiveKey && getLiveFocus() !== 'viewport') return;
```

⚠ `!visibleRef.current` is deliberately waived for the global key: with the Live viewport COLLAPSED
`visible` is false but `live` is true, and `Enter` must still stop the run the user is working against.
Verified — collapsed, the run keeps going (gen 540 → 567) and `Enter` pauses and resumes it while `Space`
posts nothing.

### The focus owner — `liveFocus`, and why it is not DOM focus

[src/live/liveState.ts](src/live/liveState.ts) carries `liveFocus: 'graph' | 'viewport'` (module global +
pub/sub, the `activeGraphKind` shape). `App` sets it from **`pointerdown` (capture) OR `pointerenter`** on
each pane wrapper — **hover is enough to type**, which is what makes "point at the graph, hit Space" work
without a click that would also deselect or paint something. It is NOT DOM focus: both panes are working
surfaces whose real focus is usually the `<body>` (clicking a canvas focuses nothing), so DOM focus cannot
answer the question. Session-transient; defaults to `graph`.

The ring is `App.module.css`'s `.livePaneFocused::after` — a 1 px accent **inset box-shadow on a
pseudo-element**, not a border or an `outline`: a border would re-size both canvases on every focus change,
and the pane's own background is painted over by the canvas stack, so the ring has to sit on top
(`z-index: 60`, `pointer-events: none` — it covers the whole pane, so without that nothing under it would
be clickable).

### The per-key table (Live)

| Key | Owner | Notes |
|---|---|---|
| `Enter` | **GLOBAL** — play / pause from either pane | the one deliberate exception, and the reason Live exists: you must be able to stop the run without leaving the graph. Stands down for INPUT / TEXTAREA / contentEditable, any `[role=dialog]` / `[role=menu]`, and the capture-review modal — **but NOT for `<select>`** (see below) |
| `Ctrl+Enter` | apply now (Phase 3) | never reaches the `Enter` arm |
| `Space` | focused surface | graph → quick-add menu; viewport → one step. `ModelerView`'s capture-phase arm stands down (before its `stopImmediatePropagation`) when the viewport has focus |
| `Esc` / `Backspace` | **never reset in Live** | Esc is the graph's dismiss key and the graph is half the workspace; a stray Esc wiping the run you are editing against is the accident this mode must not have. The staged-line-anchor arm is kept (a viewport action, and safe). Reset stays the ■ button |
| `Ctrl+C / V / X` | focused surface | the resolved double binding — see below |
| `Ctrl+Z / Y / D` | the graph, from either pane | the run is not undoable, so there is nothing to arbitrate |
| digits / numpad `1-9` | viewport only | 3D view angles. **Measured on Life3D: 0 GL draw calls with the graph focused, 4 per key with the viewport focused** |
| `F` | **both** panel sets | see the shared intent below |
| `?` | unchanged | App-level |

⚠ **`<select>` is deliberately NOT in `Enter`'s stand-down set.** A `<select>` KEEPS FOCUS after the user
picks an option, and picking an option in a node is the commonest edit in Live — the same finding Phase 3
recorded for `Ctrl+Enter`. `Enter` has no native meaning in a closed dropdown (and while its popup is open
the browser does not dispatch the key to the page at all), so nothing is stolen. Everything else still
stands down there.

### ⚠ `Ctrl+C/V/X` WAS BOUND TWICE — same phase, same target

[GraphEditor.tsx](src/modeler/vpl/GraphEditor.tsx) and `SimulatorView` both bind them bubble-phase on
`document`, neither stopping propagation. In Live a `Ctrl+V` meant for the node graph **also pasted a cell
region into the running grid**. Now each consults `getLiveFocus()` (and the simulator's arm is
`visibleRef`-gated, which alone removes the Modeler-side misfire — including the invisible 3D
`showAgentNotice` toast). **Verified:** graph focus → a node pasted, **0** `writeRegion`/`pasteAgents`;
viewport focus over the board → **1** `readRegion` + **1** `writeRegion`, **0** nodes added.

### `overlayOwnsKeyboard()` — a modal or an open menu owns the keyboard

[src/live/liveKeyboard.ts](src/live/liveKeyboard.ts) is the shared predicate:
`document.querySelector('[role="dialog"], [role="menu"]') != null`.

- **Detected from the DOM, not from focus**, because the quick-add menu focuses its search input on a
  50 ms timer (its first frame is `visibility: hidden` for viewport clamping) — and that is exactly the
  window in which someone who opened it with `Space` presses `Enter`.
- **Detected from the DOM, not from a registry**, because every one of these surfaces already renders only
  while open. The nine modal components in `src/components` therefore gained `role="dialog"`
  (correct ARIA anyway) and `GraphEditor`'s context menu gained `role="menu"`.
  ⚠ **A new modal MUST carry `role="dialog"`** or its `Enter` will also reach the transport: before this,
  `Enter` on a `ConfirmDialog` confirmed the dialog **and** toggled play (the dialog's own listener is on
  `window`, which bubbles after `document`).

### `F` — one press, both workspaces, via a SHARED INTENT

Both views already listened for `genesis-toggle-canvas-fullscreen`, so "dispatch it once" looked free.
It is not: **independent per-view toggles are permanently out of phase in Live**, because the Live panel
policy enters with the graph's panels closed and the simulator's bars open — one press would OPEN one
while CLOSING the other. So in Live the event carries `detail.collapse`, flipped by
`dispatchCanvasFullscreen()` in `liveState.ts`, and both consumers obey it; outside Live the event is bare
and each view keeps its historical toggle. The `F` key, the graph's ⛶ and the viewport's ⛶ all go through
that one dispatcher, so they can never mean different things. The two DIRECT key handlers stand down in
Live (`SimulatorView`'s returns immediately) or the view would toggle twice per press and look inert.

⚠ **Never overwrite an existing collapse snapshot with an all-closed one.** An explicit `collapse: true`
can arrive with everything already closed (the other workspace is the one with panels open); snapshotting
there makes the matching restore a permanent no-op. Both views now snapshot only when something is open,
or when there is no snapshot yet. **Verified:** with a modeler panel open and the sim bars open,
press 1 → graph area 444 → 764 px and the transport drops to its bare ear; press 2 → both exactly back.

### Perf guard 1 — FPS 30 as the LIVE DEFAULT (never a clamp)

On Live entry, if the cap is above 30 (`targetFpsRef` folds `unlimitedFps` in as 999999) the previous
value is snapshotted and 30 applied; leaving Live restores it. The popover stays fully live — an enabled
control that is internally overridden is what the doctrine forbids — so **if the user moves the FPS control
while in Live that is their value**: it is not undone on the way out and Live never auto-lowers again this
session.

⚠ **The "did the user override it" test needs a SETTLE step, and this is silent when missed.** The
override effect's deps include `live`, so it also runs in the very commit where the entry effect
*scheduled* the drop to 30 — where the committed state is still the user's previous value. Latching there
marks every entry as an override and **the default then never applies at all**; the only symptom is the
FPS chip keeping its old number. So the flag arms only once the applied default has actually been SEEN in
committed state. **Verified:** 61 → Live shows 30 → back on the Simulator tab 61; raise it to 45 inside
Live → 45 on exit, and 45 again on re-entry.

⚠ **A RESTORE IS NOT THE USER MOVING THE CONTROL** (found in the Phase-5 UI sweep, fixed there).
`applySimulationState` is the one funnel that writes the FPS programmatically (`state.targetFps` /
`state.unlimitedFps`), and it runs on **every structural Apply that re-seeds from a saved board**, on a
`.gcastate` load and on a board-carrying preset. Written straight through, it did two silent things at
once: the Live cap jumped back to the saved value mid-session (the perf guard simply gone), and the
override detector above — which INFERS "the user moved it" from a state change — **latched**, so Live
never auto-lowered again for the rest of the session. So while Live is holding its default
(`liveRef.current && preLiveFpsRef.current`) a restored cap is written into **`preLiveFpsRef` — the
snapshot, i.e. what goes back on the way out** — and never into live state. **Reproduced and re-verified
on Game of Life and Life3D:** add a cell attribute → `⟳ Rebuild needed` → Apply → exactly 1 `terminate`,
gen 0, and the chip still reads **FPS 30** (it read 61 before the fix); leaving Live still restores the
saved 61. The general lesson for anything else that ever gets a Live default: the inference has to be
blind only to the user, so every PROGRAMMATIC writer of that state needs the same redirect.

### Perf guard 2 — skip the BLIT, never the step, during a node drag

`GraphEditor` publishes React Flow's own `dragging` flag through `liveState.setLiveGraphDragging`;
`SimulatorView` reads it through a **subscription into a ref** (not `useSyncExternalStore` — this component
must not re-render twice per gesture) and gates the per-`stepped` `draw()` **and its direct-render rAF
follow-up**. `sendNextStep()`, the `setGeneration` throttle and the whole recording block are untouched,
and the **falling edge draws once immediately** so the board is never left stale.

- ⚠ Deliberately NOT routed through the unlimited-gens fast path: that one also skips the colour pass and
  carries its own voxel-free-mode carve-out.
- ⚠ The editor is unmounted on every non-Modeler/non-Live tab and React Flow emits no `dragging: false`
  for a gesture that ends that way, so `GraphEditor` clears the flag from an unmount cleanup.
- **Measured, playing, 1.5 s windows** — Game of Life (2D, WebGPU): normal **79 blits / 39 steps**;
  dragging **0 blits / 40 steps, gen +42**; release **5 blits within 60 ms**. Particle Life (2D agents,
  GPU-resident direct render): **80 / 0 / 5**, and **0 `attachAgentCanvas`** during the drag.

### Overseer ↔ Live — hide one way, grey the other

`handleRunExperiment` early-returns in Live, the **Experiments tab strip is HIDDEN** there and
`rightPanelTab` is coerced to `'controls'` (a hidden control needs its STATE handled, not just its markup);
the Controls arm also renders on `live` so the panel is never blank for the one frame before the coercion
lands. In the other direction the **Live nav button is GREYED with the reason** while an experiment runs —
`overseerRunning` is published through `liveState` **in the same statement block as the React state**
(the mirror-invariant discipline) and cleared on unmount. Doctrine: from the Experiments panel the working
state is reachable (Abort is right there) ⇒ grey; from inside Live it is not ⇒ hide. Rationale and the
abort-on-any-model-change mechanism: [`overseer.md`](overseer.md).

### A shortcut named in a tooltip has to STAY TRUE

`Esc` no longer resets in Live, and `Space` follows the focus owner, so the transport titles are
Live-aware: **Reset (Esc)** → *Reset*, **Step (Space)** → *Step (Space — with the viewport focused)*.
A control that names a key it no longer answers to is worse than one that names none.

### Verified (real app, real worker, real GPU) — Phase 4

**The pre-existing fix, A/B on the same build tree** (the Phase-3 file stashed, reproduced, restored) —
the table at the top of this section. **Game of Life (2D, WebGPU) in Live:** graph focus → `Space` opens
quick-add and posts **0** steps, `Esc` closes it with **0** resets and the counter climbing 259 → 306;
viewport focus → `Space` posts **exactly 1** step, `Esc` and `Backspace` post **0** resets; `Enter` toggles
play from **both** panes; `Enter` inside the quick-add search input adds the node and **does not** toggle
play; `Enter` with a node's `<select>` focused **does** toggle play; `Ctrl+Z` undoes a graph edit from
**either** focus; clipboard routing both ways (above); `F` collapsing and restoring both panel sets
(measured widths above); the focus ring following **real** hover left/right. **Life3D (3D voxel):** the
numpad digits (0 vs 4 GL draws by focus) and a real orbit drag in the Live pane (8 GL draws, view changed).
**Particle Life:** the skip-blit numbers above. **GoL Replicate Statistics:** Run → the Live button
disabled with the reason; Abort → enabled; in Live no tab strip and no Run Experiment button.
**Simulator tab unchanged:** `Esc` still resets (1 `reset`, gen → 0), `Space` still steps.
**0 console errors throughout** (`window.onerror` + `unhandledrejection` + a `console.error` hook installed
before every reproduction). `tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`check-compile-identity --compare` (**31 models, all surfaces unchanged**), `parity-agent-wasm.mjs` and
`verify-agent-render.mjs` all green.

**NB for future verification here:** (1) a React Flow node drag still cannot be driven synthetically, so
the skip-blit guard is verified through the DEV hook `window.__setLiveGraphDragging` (guarded by
`import.meta.env.DEV` in `liveState.ts`) which drives the exact flag the real gesture publishes;
(2) **a module-level flag read across an HMR update can be stale** — the first skip-blit run measured no
effect until a full reload, because the hot-replaced `liveState` module was not the instance
`SimulatorView` held; reload before measuring anything that crosses a module global;
(3) synthetic `pointerover` does NOT reproduce React's `onPointerEnter` synthesis — use the browser's real
hover for focus-follows-hover; (4) a `keydown` dispatched on `document` never reaches React's own
root-delegated handlers — dispatch on `document.activeElement` instead.

---

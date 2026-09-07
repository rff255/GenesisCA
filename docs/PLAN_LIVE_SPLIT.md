# Plan — **Live** mode (split workspace)

> **Status: plan, no code.** Design authority: [IMPACT_MAP_LIVE_SPLIT.md](IMPACT_MAP_LIVE_SPLIT.md).
> Illustrated companion (required by the *Illustrated plans* rule):
> [PLAN_LIVE_SPLIT.html](PLAN_LIVE_SPLIT.html) — before/after layouts, the layout menu, the four
> transport-chip states, and the keyboard-ownership table, with a live Game-of-Life board in the mockups.
> Origin brainstorm: [BRAINSTORM_SEE_THROUGH_CANVAS.md](BRAINSTORM_SEE_THROUGH_CANVAS.md) + `.html`.
>
> **Read the impact map first.** Every trap referenced by number below (T1…T5, Trap A…E) is defined there
> with `file:line` evidence. This document is the execution order, not the analysis.

---

## Phase 0 — the shape of the thing

**Live** is a third top-level mode. The rule graph and the running simulation sit side by side in two
opaque, fully interactive panes divided by a draggable splitter. Editing the graph updates the running
rule without stopping the run; a half-wired graph keeps the *last good* rule instead of stopping
everything; a structural edit asks before re-seeding the board.

```
Modeler   ·   Simulator   ·   ◐ Live
                                └── [ node graph ][splitter][ simulation viewport ]
                                    layout: dock right | dock bottom | swap | collapse
```

### The five invariants this feature must never break

| # | Invariant | Where it comes from |
|---|---|---|
| **I1** | `SimulatorView`'s **position in the React element tree is identical** in `simulator` and `live` mode. Only `className` / `style` differ. | Impact map T1 — a remount destroys the worker, WASM memory, WebGPU device and grid state |
| **I2** | A **failed graph compile never reaches the worker** while Live is shown. | Impact map T3 / Trap A — `sim.worker.ts:5899` nulls `stepFn` |
| **I3** | A **deferred structural rebuild never advances `prevModelRef`**. | Impact map T4 / Trap C |
| **I4** | **Exactly one surface owns each keystroke**, and `Esc`/`Backspace` never reset the board in Live. | Impact map T2 |
| **I5** | **Zero compiler / emit diff.** `check-compile-identity` must report *all surfaces unchanged*. | CLAUDE.md ALL-TARGET rule; the harness hashes error strings too |

### Phase map

| Phase | Title | Output |
|---|---|---|
| 1 | *(this session)* Impact map + plan + illustrated companion | 3 docs, no code |
| **2** | **Foundation** — the mode, dual mount, split layout, splitter + layout menu + persistence, viewport bar, panel policy | Live exists and is usable; the rule pipeline is still today's |
| **3** | **Pipeline** — last-good-rule, apply policy, structural-rebuild prompt, debounce stretch | Editing while it runs is safe |
| **4** | **Input + guards** — keyboard ownership, focus ring, `Enter`/`Esc`/`F`, Overseer exclusion, FPS cap, skip-blit | Live is predictable, and two pre-existing keyboard bugs are fixed |
| **5** | **Docs + verification sweep** | Every doc layer in sync; the full gate run |
| **6** | **Stretch** — Document Picture-in-Picture pop-out, behind a feasibility spike | **DEFERRED (2026-09-07)** — the spike ran: the canvases pass, the input layer does not. Findings in [§ 6.4](#64-phase-6--the-spike-as-run-the-measurements-and-why-this-is-deferred-2026-09-07); no `src/**` change |

Phases are executed by **separate sessions**. Each one starts by re-reading the impact map and this
plan's phase section, and ends green on `npx tsc -b` + `npm run build`.

---

# Phase 2 — Foundation

**Goal:** `Modeler · Simulator · Live` in the nav; entering Live shows the graph and the *already running*
simulation side by side, with a working splitter, layout menu, persistence and viewport bar. The
edit→rule pipeline is untouched — it behaves exactly as it does today (a bad compile still shows the red
banner; a structural edit still re-seeds). Phase 3 fixes that.

## 2.1 New files

| File | What |
|---|---|
| `src/live/liveUiState.ts` | Module-level Live **layout** snapshot + localStorage write-through under `genesisca_live_layout`. Shape: `{ dock: 'right' \| 'bottom'; swapped: boolean; split: number /* 0–1 */; viewportCollapsed: boolean; applyPolicy: 'auto' \| 'ondemand'; simPanelsCollapsed: boolean }`. Modelled on `graphState.ts`'s `genesisca_graph_view_settings` block (module global + write-through), **not** on `genesisca_sim_settings` (impact map D6). |
| `src/live/liveState.ts` | Module global + pub/sub (`get… / subscribe… / set…`, equality-guarded, notifies listeners) for the runtime flags every tree needs: `liveShown`, `liveFocus: 'graph' \| 'viewport'`, `liveGraphDragging`. Copy the exact shape of `activeGraphKind` in `graphState.ts:57-72` — memoised consumers need `useSyncExternalStore`. |
| `src/simulator/simLayoutState.ts` | The `simLayoutApi` seam: `{ scheduleLayoutDraw(): void; drawNow(): void }`, registered by `SimulatorView` on mount, nulled on unmount. The `quickAddApi` pattern (registered in `GraphEditor`, consumed in `ModelerView.tsx:159-163`). **Required** — the Live splitter lives outside `SimulatorView` (impact map T5). |
| `src/live/LiveSplitter.tsx` | The drag handle + its double-click-to-50 % behaviour. Pointer-events based, `setPointerCapture` on a real drag only (`try/catch` — the `tryCapture` rule from `SpriteSheetDialog`). |
| `src/live/LiveViewportBar.tsx` | The bar over the viewport pane: model name · layout menu · apply-policy switch · transport chip (Phase 3 fills the chip) · brush / indicators popover triggers. |
| `src/live/LiveViewportBar.module.css`, `src/live/Live.module.css` | Styles. Every colour through a theme token; both themes checked. |

## 2.2 Files to change

### `src/App.tsx` — the mode, the wrappers, the layout classes

1. `:23` — `type AppMode = … | 'live'`.
2. `:34-49` — a third `modeIcon(...)` const (`LIVE_ICON`). Suggested glyph: a split rectangle with a play
   triangle in the right half, so it reads as "graph + run".
3. `:380-389` — a third `navModeButton`. **Disabled with a `title` reason while an Overseer experiment
   runs** (Phase 4 wires the predicate; Phase 2 leaves the button always enabled).
4. `:436-444` — the layout. **This is the I1-critical edit.**

```jsx
<main className={contentClass}>            {/* styles.content + a Live layout modifier */}
  <div className={modelerPaneClass}>       {/* NEW wrapper, mounted in EVERY mode */}
    {(mode === 'modeler' || mode === 'live') && <ModelerView />}
  </div>
  {mode === 'live' && !liveLayout.viewportCollapsed && <LiveSplitter … />}
  <div className={simulatorPaneClass}>     {/* the EXISTING wrapper at :438, reclassed */}
    <SimulatorView visible={mode === 'simulator' || mode === 'live'} activeTab={mode === 'simulator'} />
  </div>
  {mode === 'help' && <HelpView />}
  …
</main>
```

- `modelerPaneClass` / `simulatorPaneClass` are `display: contents` outside Live (so the Modeler and
  Simulator tabs are **byte-identical to today**) and real flex items inside it.
- ⚠ **The ModelerView wrapper must exist in every mode**, even `help` / `library`, or entering Live from
  the Modeler remounts React Flow. It is an empty `display: contents` div — free.
- The splitter is a Live-only sibling between the two wrappers; `{cond && …}` renders `null` elsewhere and
  holds the slot.

5. **Drop-routing guards** (`:226-283`): every `setMode('simulator')` (`.csv`/`.tsv`/`.asc`, image,
   `.tif`, `.geojson`) and the `setMode('modeler')` in the `.gcamacro` arm (`:249`) become
   `if (mode !== 'live') setMode(...)`. Dropping a file while in Live must not eject the user from Live —
   both consumers are already on screen. (`handleDroppedFile` reads `mode` through the existing
   latest-ref at `:285-286`.)

### `src/App.module.css`

`.content` (`:237-240`) is a plain block today. Add Live modifiers only — never touch the base rule:

```css
.content.liveRight  { display: flex; flex-direction: row; }
.content.liveBottom { display: flex; flex-direction: column; }
.content.liveSwap   { flex-direction: row-reverse; }       /* or column-reverse under liveBottom */
.livePane { position: relative; overflow: hidden; min-width: 0; min-height: 0; }
```

`min-width: 0` / `min-height: 0` are load-bearing: without them a flex item refuses to shrink below its
content and the splitter jams. The two panes get `flex: <split> 1 0%` and `flex: <1-split> 1 0%` from
inline style, so the fraction drives the layout with no pixel maths.

### `src/simulator/SimulatorView.tsx`

1. `:2276` — the signature gains `activeTab`: `{ visible = true, activeTab = true, hideInstructionsPill = false }`.
   **`visible` keeps its name and now means "shown"** (impact map D2). Default `activeTab = true` so the
   standalone viewer (`src/viewer/ViewerApp.tsx`) is unchanged.
2. `:10718-10720` — the auto-pause arm becomes `else if (!activeTab && playing) setPlaying(false);`
   and `activeTab` joins the effect deps at `:10721`. **Everything else in that effect keeps keying off
   `visible`** — the re-present block (`refreshDisplay` / `setGridCamera` + `refreshGridDisplay` /
   `setAgentCamera` + `refreshAgentDisplay`) must fire on Live-enter, which it does for free.
3. Register `simLayoutApi` on mount (`{ scheduleLayoutDraw, drawNow }`), null it in the cleanup.
   `drawNow` = clear `layoutResizeUntilRef.current = 0` then `drawRef.current()` — the same two statements
   the layout `useLayoutEffect` performs at `:15011-15012`.
4. **Live panel policy** — a `liveShown` effect that, on entry, snapshots
   `{leftPanelOpen, rightPanelOpen, topBarOpen, bottomBarOpen}` into a new `preLivePanelStateRef` and sets
   the two side panels closed (bars stay open — the transport bar *is* the transport). On exit it restores
   the snapshot **including false entries**, exactly like `prePanelStateRef` at `:15080-15096`.
   ⚠ Without this the collapse leaks into the Simulator tab (impact map S7).
5. **The Live viewport bar** renders inside `.canvasArea` with `data-sim-overlay` — mandatory, or a click
   on it falls through and paints the grid (`modeler-ui.md`: *"ALL overlay elements on the canvas … MUST
   have `data-sim-overlay`"*). It is gated on `liveShown`.
6. Brush + indicators **popovers**: reuse the existing `overlayPopup` single-popover state (one at a time,
   capture-phase outside-`pointerdown` + `Escape`-with-`stopPropagation` dismissal). ⚠ Any chart inside a
   popover must mount its wrapper `<div ref={wrapRef}>` unconditionally so `useMeasuredWidth` /
   the `useLayoutEffect` fallback can measure it — a chart mounted at width 0 stays at 0 forever
   (`modeler-ui.md`, `overseer.md`).

### `src/modeler/ModelerView.tsx`

Optional and small: on first Live entry, collapse both side panels via the existing
`toggleCanvasFullscreen` path if `liveUiState` says so. Nothing else — **React Flow resizes itself**
(`simulator-ui.md`: "The Modeler's React Flow canvas is untouched and resizes itself").

## 2.3 The splitter

- `onPointerMove` → write the new fraction into `liveUiState` (React state in `App` mirrors it) **and**
  call `simLayoutApi?.scheduleLayoutDraw()`. That is the rAF-coalesced draw **plus** the 140 ms
  `layoutResizeUntilRef` window that holds off the `OffscreenCanvas` re-attach — measured 26 →
  2 `attachAgentCanvas` messages over a 30-move drag.
- `onPointerUp` and every layout-menu action → `simLayoutApi?.drawNow()` (discrete change = final size;
  do not make a dock-swap wait out the settle window).
- Double-click → `split = 0.5`.
- Collapse → `viewportCollapsed = true`; the splitter unmounts and a restore ear appears (the
  `leftPanelExpandBtn` / `panelExpandBtnRight` pattern).
- Clamp the fraction to `[0.15, 0.85]` so neither pane can be dragged to nothing (collapse is the
  explicit action for that).

## 2.4 UI-doctrine disposition (Phase 2 controls)

| Control | Disposition | Reason |
|---|---|---|
| **Live** nav button | visible + enabled (Phase 4 adds the Overseer grey-out) | — |
| Layout menu: **dock right / dock bottom** | both always visible | both always reachable |
| **Swap sides** | visible | — |
| **Collapse viewport** | visible; becomes **Restore** when collapsed | never inert |
| **Splitter** | **hidden** while the viewport is collapsed | structurally nothing to divide |
| Simulator **left/right panel ears** in Live | visible — the user may still open them | not hidden; the Live policy only sets the *default* |
| **Experiments tab strip** in Live | **hidden** (Phase 4 enforces; Phase 2 may land it here) | structurally impossible: an experiment cannot run in Live |
| Brush popover trigger | **hidden** when the model has no paintable layer (the existing `showAgents` / mapping gates decide) | structurally impossible |
| Indicators popover trigger | **hidden** when `model.indicators` is empty | structurally impossible |

## 2.5 Verification recipe

- `npx tsc -b` · `npm run build`.
- **`node scripts/check-compile-identity.mjs --compare <baseline captured BEFORE the first Phase-2 commit>`
  → "31 models, all surfaces unchanged"** (I5). Also `git diff --stat` must show **no** file under
  `src/modeler/vpl/compiler/**` or `src/modeler/vpl/nodes/**`.
- **The remount proof (I1), and it must be a measurement, not a look:** load **Game of Life**, play to
  generation ≥ 500 in the Simulator, switch to **Live**, and assert the generation counter **keeps
  climbing from where it was** and `window.__simWorker` is the **same object identity** before and after.
  Repeat Modeler → Live and Live → Modeler → Live. A remount shows as Gen 0.
- **Splitter attach count:** on **Particle Life** (WebGPU agents, direct render), spy on
  `worker.postMessage` and drag the splitter ~30 moves. Expect **≤ 2** `attachAgentCanvas` messages and
  the display canvas matching its container at every sample. On **Accretor** (300³ voxel) expect the same
  for `attachVoxelCanvas`, and `stepped` must still ship **no** colours (free mode preserved).
- **2D + 3D + agents:** Game of Life (2D grid), **Life3D** (3D voxel), **Particle Life 3D** (3D agents),
  **Growing Tissue** (agents-only, no grid — proves the pane sizes correctly with no CA layer), and one
  **both-topology** model (Chemotaxis) for the E2 composite path.
- Layout menu: all four actions in both dimensions; the canvas backing store matches the container after
  each (`canvas.width === round(area.clientWidth × dpr)` in 3D).
- Reload the page → the dock, swap, split fraction and collapse state come back.
- **0 console errors** throughout (install a `window.onerror` handler *before* reproducing — the
  blank-screen-React-crash rule).

## 2.6 Phase 2 — AS BUILT, and where it deviates from §2.1–2.5 (2026-09-07)

Phase 2 shipped. `tsc`, `npm run build`, `check-compile-identity --compare` (**31 models, all surfaces
unchanged**), `verify-agent-render.mjs` and `parity-agent-wasm.mjs` all green; `git diff --stat` touches
no file under `src/modeler/vpl/compiler/**` or `src/modeler/vpl/nodes/**`. Reference documentation is in
[`docs/areas/simulator-ui.md`](areas/simulator-ui.md) § *LIVE mode* and
[`docs/areas/modeler-ui.md`](areas/modeler-ui.md) § *LIVE mode*. The deviations, and why:

| § | Planned | As built | Why |
|---|---|---|---|
| 2.1 | `src/live/liveState.ts` holds `liveShown`, `liveFocus`, `liveGraphDragging` | It holds **`liveLayoutLocked`** only | Phase 2 has no consumer for the other three. `liveShown` is a PROP (`live`) on `SimulatorView` — one source of truth beats a mirrored global; `liveFocus` / `liveGraphDragging` are Phase 4's, and the module is there for them. `liveLayoutLocked` IS needed now: `LiveSplitter` lives outside `SimulatorView` and must grey out while a recording pins the frame size (§S12/D9). |
| 2.1 | `liveUiState` field `simPanelsCollapsed` | **Dropped** | The `preLivePanelStateRef` save/restore covers it, and Live always enters with the panels collapsed by policy. A persisted field nothing reads is dead weight. `applyPolicy` IS kept (Phase 3 reads it). |
| 2.2 §6 | Brush + indicators as **popovers** hosting extracted right-panel JSX | The simulator's two side panels **FLOAT over the canvas in Live** (`.liveOverlayPanels`), toggled by Settings / Controls buttons on the viewport bar | Extracting ~760 lines of inline right-panel JSX (referencing dozens of locals declared below the return, plus `brushSectionRef` / `brushSectionH`) into render-body variables is a large, risky refactor whose only gain is the popover *shape*. Making the existing panels absolutely-positioned achieves the same thing — panel-sized surfaces floating over the viewport, reached from the bar — with a CSS modifier and zero JSX movement, and it also avoids any double-mount of the indicator charts (the mount-at-width-0 trap). |
| 2.2 §5 | Viewport bar carries the **apply-policy switch** and the transport chip | **Neither is rendered** | Phase 2 does not change the edit→rule pipeline, so both would be visible, enabled and internally inert — precisely what the "an enabled control must do something" rule forbids. Phase 3 lands the behaviour and the controls together. |
| 2.2 (ModelerView) | "Optional and small: collapse both side panels on first Live entry" | **Done, and it is NOT optional** | Measured on a 500 px Live graph pane with the Properties panel open: `.graphArea` = **101 px**. With the panels closed it is 421 px. It carries the same snapshot/restore discipline as the simulator's, **plus** an unmount-only cleanup that writes the snapshot back into `modelerUiState` (the write-through effect persists the collapsed state, so a Live → Library unmount would otherwise leave the panels shut for good). |
| 2.3 | Collapse ⇒ the viewport pane shrinks away | Collapse ⇒ the pane is **`display: none`** and `visible` goes false | `canvas.parentElement?.clientWidth ?? 500` returns **0** (not the fallback) for a 0-width pane, so `canvas.width = 0` and the next `drawImage` throws `InvalidStateError` and unmounts React. `display: none` is the proven-safe hidden state. The auto-pause arm therefore had to become `!activeTab && !live && playing` (the impact map's own §3 formulation) so a collapsed viewport does not stop the run. |
| 2.4 | Brush / Indicators popover triggers hidden when the model lacks that layer | One **Controls** toggle, always shown | It opens the whole right panel, which always has content (the brush is always there). Nothing inert is exposed. |
| — | *(not in the plan)* | The **3D View panel's** inline `top` is `live ? 44 : 12` | It is the one other top-right `.canvasArea` overlay and it collided with the viewport bar (measured: bar `44..72`, panel `48..491`). |
| — | *(not in the plan)* | One-line fix: the 3D GL canvas's window-level `onUp` now checks `hasPointerCapture` before `releasePointerCapture` | **Pre-existing**, reproduced on the plain Simulator tab: that call throws `NotFoundError` for any pointer release outside the GL canvas while a 3D model is loaded, so it fired on every transport-button click. The Live splitter drives it 30× a drag, which made "0 console errors" unverifiable otherwise. |

**What Phase 3 / Phase 4 inherit.** The pipeline is still today's: a bad compile still nulls the running
rule and still shows the red banner; a structural edit still re-seeds. Keyboard ownership is untouched, so
in Live both surfaces still receive `Space` / `Enter` / `Esc` / `Backspace` / `Ctrl+C/V/X` — those remain
the pre-existing defects §6 describes. The Live nav button is always enabled (no Overseer gate yet), and
the FPS cap / skip-blit guards are not in.

---

# Phase 3 — Pipeline (last-good-rule, apply policy, rebuild prompt)

**Goal:** editing the graph while it runs is safe. A half-wired graph keeps the previous rule; a
structural edit asks before re-seeding; the user chooses Auto or On-demand.

## 3.1 Last-good-rule (I2)

All of this is inside `SimulatorView.tsx`'s model effect (`:8937` onward). **`sim.worker.ts` is not
touched.**

1. **New state channel** — `const [ruleState, setRuleState] = useState<{status:'ok'|'stale'|'pending'|'rebuild'; message:string}>` .
   ⚠ **Do not reuse `compileError`**: it is the simulator's general error surface with 18 call sites, of
   which only 6 are graph compiles — CSV / GeoTIFF / GeoJSON / preset import failures and the worker's
   pushed `error` message all live there (impact map Trap B). Those keep the red banner in every mode.
2. **The soft-recompile arm** (`:9069-9226`): after `safeCompileGraph` (`:9096`) and
   `compileAgentModel`, if **either** produced an error **and** `liveShown`:
   - **do not post the `recompile` message** (`:9156`) — the worker keeps its last good `stepFn`,
     `wasmStepFn`, WebGPU pipeline **and** `agentBehaviourFn` by construction;
   - `setRuleState({status:'stale', message})`;
   - leave `compileError` alone (so the red banner does not appear in Live);
   - **still run `refreshShowCode`** — Show Code should reflect what the user is typing.
   ⚠ **Both halves** — cell and agent (`:9116` and `:9120`) — or an agent-graph edit half-freezes the
   model (impact map Trap E).
3. **The init arm** (`compileModel`, `:4802-4820`) needs the same treatment for the case where Live is
   entered on an already-broken model: `setRuleState('stale')` rather than the banner.
4. **Recovery:** the first error-free compile posts `recompile` normally and sets `status: 'ok'`.
5. The **amber `!` badges** on the offending nodes already exist (`nodeValidation.ts` →
   `detectMissingConfig` → CaNode header badge). Nothing to build; the chip's tooltip should say
   *"N nodes need attention"* and clicking it should select/zoom the first — reuse `NodeExplorer`'s
   existing focus path if it is a one-liner, otherwise defer the click behaviour.

## 3.2 Apply policy

- `liveUiState.applyPolicy: 'auto' | 'ondemand'`, edited from the viewport bar's switch.
- **Auto** = today: the 100 ms `scheduleSync` (`GraphEditor.tsx:1092`) → model → the effect applies.
- **On demand**: the model effect, when `liveShown && applyPolicy === 'ondemand'`, **skips both the reinit
  and the recompile** and sets `status: 'pending'`. `Ctrl+Enter` re-runs the apply.
  ⚠ **Do not change `scheduleSync`.** It also feeds undo/redo, the macro write-back and the dirty flag;
  holding the *model→worker* step keeps all of that live.
- ⚠ **`Ctrl+Enter` must be capture-phase on `document`** (the `ModelerView.tsx:298` pattern) so it works
  with focus in the graph, and must stand down when a field / menu / modal has focus.
- Nothing in the Simulator tab changes: `applyPolicy` is only consulted while `liveShown`.

## 3.3 Structural-rebuild prompt (I3)

1. **New `appliedModelRef`** = the last model actually pushed to the worker.
2. `needsFullInit` (`:8946-9040`) is computed against **`appliedModelRef.current`**, not
   `prevModelRef.current`.
3. `prevModelRef.current = model` at `:8939` may stay (other consumers rely on it), but
   **`appliedModelRef.current = model` is assigned only inside the two branches that actually apply**
   (`:9041` reinit and `:9069` recompile).
4. When `liveShown && needsFullInit && !userConfirmedRebuild`: **do not reinit.** Set
   `status: 'rebuild'` and render the chip prompt:
   *"Rebuild needed — the board will re-seed. **Apply** / **Later**"*, with the second line naming what
   comes back: `resetRestoresBoard` + `savedBoard` (`:13128-13130`, `resetDefaultMode`) resolve it to
   *"the saved board"* or *"a fresh seed from the Init Events"*.
5. **Apply** → run the reinit and advance `appliedModelRef`. **Later** → keep deferring; every further
   structural edit still compares against the same applied baseline, so **N edits cost one reset**.
6. ⚠ The deferred state must clear on: model load (`modelVersion` change), leaving Live, and a manual
   Recompile (`handleRecompile`, `:13161`) — otherwise a stale prompt can fire a rebuild against a model
   the user has since replaced.

## 3.4 Debounce stretch (corrected scope)

The brainstorm framed this as fixing a compile storm during **node drags**. It is not:
`needsSync` (`GraphEditor.tsx:2061-2066`) fires only on `remove`, position **drag-END**, `dimensions` and
`replace` — a node position drag syncs **once, at release**.

**What actually storms:** a **held inline widget** inside a node (a number field / slider dragged) and a
**comment/group resize** (`dimensions` ticks continuously). So:

- Stretch `scheduleSync`'s timer from 100 ms to ~400 ms **while a pointer is down on the graph canvas**
  (a `pointerdown`/`pointerup` pair on the editor wrapper feeding `liveState`), and collapse back on
  release with an immediate flush.
- Gate it on `liveShown` so the Modeler tab's feel is unchanged.
- ⚠ **Do not undo the 092a8c7 graph-equality guard.** A `dimensions`-only write-back that is deep-equal
  already returns the same state ref, which is what stops React Flow's mount-time measurement from
  triggering a soft recompile. Live depends on it.

## 3.5 UI-doctrine disposition (Phase 3 controls)

| Control | Disposition |
|---|---|
| Apply-policy switch (Auto / On demand) | always enabled |
| Transport chip | always visible **in Live**; **not rendered in the Simulator tab** (structurally meaningless — the red banner is the Simulator's surface) |
| Chip **Apply** button | shown only in `pending` / `rebuild`; **hidden** in `ok` / `stale` |
| Chip **Later** button | shown only in `rebuild` |
| Red compile banner (`.errorBanner`, `:15523`) | **hidden in Live for graph-compile errors only**; still shown for import/export/worker errors, and unchanged in the Simulator tab |

## 3.6 Verification recipe

- `npx tsc -b` · `npm run build` · `check-compile-identity --compare` → **all surfaces unchanged**.
- **Last-good-rule, measured:** Game of Life, playing. Delete the edge into `Set Attribute` (a guaranteed
  compile error). Assert: the generation counter **keeps climbing**, the amber `!` appears on the node,
  the chip reads `● stale`, **no `recompile` message was posted** (spy on `worker.postMessage`), and the
  red banner is absent. Re-wire → the chip returns to `● synced` and the *new* rule takes effect (change
  the survival count and watch the population shift).
- Repeat on the **agent** graph (Boids: break an edge into the behaviour root) — the agents must keep
  moving, not freeze.
- **The banner is not over-suppressed:** while in Live, drop a malformed `.csv` and confirm the red
  banner still appears with the import error.
- **Rebuild prompt:** on Game of Life, add an attribute → the chip shows `⟳ rebuild needed`, **the board
  does not re-seed**, the generation counter keeps climbing. Add two more attributes → still one prompt.
  Click **Apply** → exactly one reinit (spy: one worker `terminate` / one `init`). Then set
  `resetRestoresBoard` and confirm the prompt's copy names the saved board.
- **On-demand:** switch the policy, make three edits → `● pending`, the rule does not change (verify by
  behaviour, not by the chip). `Ctrl+Enter` → one `recompile`, behaviour changes.
- **3D:** repeat the last-good-rule and rebuild-prompt checks on **Life3D** (a depth change is a
  `needsFullInit` trigger — `:8955`) and **Particle Life 3D**.
- `node scripts/parity-agent-wasm.mjs` green (nothing should touch it; run it to prove so).

## 3.7 Phase 3 — AS BUILT, and where it deviates from §3.1–3.6 (2026-09-07)

Phase 3 shipped. `tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`check-compile-identity --compare` (**31 models, all surfaces unchanged**) and `parity-agent-wasm.mjs`
are green; `git diff --stat` touches **no file** under `src/modeler/vpl/compiler/**` or
`src/modeler/vpl/nodes/**`, and `sim.worker.ts` has **no diff at all**. Reference documentation:
[`docs/areas/simulator-ui.md`](areas/simulator-ui.md) § *LIVE mode — the edit→rule PIPELINE*,
[`docs/areas/modeler-ui.md`](areas/modeler-ui.md) (the debounce stretch) and
[`docs/areas/simulation-engine.md`](areas/simulation-engine.md) (the withheld-message contract).

| § | Planned | As built | Why |
|---|---|---|---|
| 3.1.1 | `ruleState` written directly at each compile arm | Two helpers, **`reportRuleCompile` / `appendRuleCompile`**, are the ONLY writers, and every graph-compile arm (init + soft, cell + agent) routes through them | One sink means the "banner outside Live, chip inside Live" rule cannot drift between the four arms. `reportRuleCompile` additionally **refuses to overwrite `pending` / `rebuild` with "Synced"** — a compile can be triggered from OUTSIDE the model effect (Apply dimensions / an image import → `initWorkerWithDimensions` → `compileModel`) while a deferral is outstanding, and reporting "synced" there would claim the worker has a model it does not have. |
| 3.1 | Suppress the banner "in Live for graph-compile errors only" | **The two render sites are untouched.** In Live the graph-compile arms simply never write `compileError` (they clear it), so the banner keeps rendering exactly the 12 non-compile sources | Less code, and the suppression cannot be forgotten at a render site. Verified both ways: a malformed `.gcapreset` dropped in Live still raises the banner; switching to the Simulator tab with a broken graph raises it there. |
| 3.1.5 | The chip's tooltip says *"N nodes need attention"*, clicking it selects/zooms the first | The tooltip carries the **compiler message**; the chip click toggles the rebuild prompt back open | The compiler message is the actionable text (the node badges already point at the nodes), and "select the first offending node" is not a one-liner from `SimulatorView` — deferred as §3.1.5 allows. |
| 3.2 | `Ctrl+Enter` "must stand down when a field / menu / modal has focus" | Stands down only for **`TEXTAREA` and `contentEditable`** (plus the capture-review modal) | A `<select>` KEEPS FOCUS after the user picks an option, and picking an option in a node is the commonest way to make the edit you then want to apply — standing down there makes the shortcut do nothing exactly when it is most wanted (reproduced during verification). `Ctrl+Enter` has no native meaning in a `<select>` or a single-line `<input>`, so nothing is stolen. |
| 3.3.3 | "`prevModelRef.current = model` at the top may stay" | It stays, and `appliedModelRef` is the baseline for `needsFullInit` — **and also for `snapJustChanged` and the `updateIndicators` comparison** in the same effect | Both of those asked "what did the previous RENDER hold" when the honest question is "what does the WORKER have". Left on `prev`, a withheld run would drop an indicator edit the worker never received. |
| 3.3.6 | The deferred state clears on model load / leaving Live / manual Recompile | **Model load and manual Recompile force an APPLY** (they adopt the current model as the baseline); **leaving Live flushes** (`appliedModelRef.current !== model` ⇒ re-run with `live` already false) | Clearing without applying would silently lose the change — the same Trap-C class the prompt exists to prevent. Flushing on exit is also what makes the Simulator tab's red banner appear for a graph broken in Live. |
| — | *(not in the plan)* | An **`applyNonce`** in the model effect's dep list + a one-shot `liveApplyForceRef` | The effect only runs on `[model, compileModel]`, so an Apply with an unchanged model would not re-run it. One bump = one apply, which is what makes "N structural edits cost ONE reset" observable. |
| — | *(not in the plan)* | **`liveShown` published through `liveState.ts`** by `App` | `GraphEditor` needs it for the debounce stretch and sits in another React tree; threading a prop `App → ModelerView → GraphEditorInner → GraphEditor` for a flag read inside a native `pointerdown` listener buys nothing over the project's established cross-tree seam. `SimulatorView` still uses its own `live` PROP. |
| 3.4 | Stretch "while a pointer is down on the graph canvas", listeners on the editor wrapper | `pointerdown` is scoped to the wrapper, but **`pointerup` / `pointercancel` are on `document` (capture)** | A widget can capture the pointer, after which the release never reaches the wrapper and the flag would latch on. |

**Observed during verification, NOT fixed here (out of Phase 3 scope):**

- **The agent compilers are LENIENT about unset config.** Clearing a `Get Self Attribute` /
  `Get Model Attribute` / `Table Lookup` / `Set Attribute` selection in an AGENT graph produces **no
  compile error** — it emits an undefined identifier and fails at RUNTIME (`[agents] behaviour run
  failed: r__undef is not defined`), which surfaces through the worker's pushed `error` message on the
  red banner. The last-good-rule gate keys on the COMPILE result, as specified, so those cases post the
  recompile normally. Deleting the **Behaviour Step** node is a real agent compile error and was used for
  the Trap-E verification. Worth a look as a separate node-validation item.
- `Esc` and `Backspace` still reach `handleReset` from anywhere (the pre-existing defect Phase 4 fixes) —
  it had to be avoided during verification.

### ⚠ POST-SHIP DEFECT — "Live syncs by going back to a previous state" (user report, 2026-09-07)

Phase 3's premise — *a soft recompile preserves the board, because the main thread sends no board* — held
on the main thread and **was false in the worker for every WebGPU-target model**. Reported as: *"when I
change something in the node canvas and the live simulation syncs (regardless of Auto or Apply), instead
of continuing from the state it is at with the changes, it goes back to a previous state, like last time
I interacted with it. That defeats the purpose of the whole Live feature."*

- **Root cause — `sim.worker.ts`, `startWebGPUInit`.** Under the WebGPU grid target the attribute buffers
  live on the GPU (`gpuOwnsAttrs`, set by every `runStepWebGPU`); the CPU `readAttrs` mirror is refreshed
  only by an explicit readback (`getState`, a cell-reading paint, the engine-toggle drains). A `recompile`
  whose WGSL differs from the running shader misses the pipeline cache, **destroys the runtime and
  re-seeds the fresh buffers with `uploadAttrs(rt, readAttrs)`** — the board is overwritten with the
  last-synced generation while the generation counter keeps its value. "Last time I interacted with it"
  is literally what the mirror holds.
- **It is NOT a Live bug and NOT in Phase 3's diff.** The identical rewind happens from the Simulator tab
  (edit in the Modeler, switch back) and predates the whole feature — measured on both. Live is what
  turned a rare annoyance into "the feature is pointless", because it recompiles constantly.
- **Fix (worker only, zero emit diff):** the message dispatcher gains the **grid sibling of the agent
  one-shot readback** that was already there for `agentStoreStale` (audit M3) — defer the `recompile`,
  `await ensureCpuAttrsFresh()`, replay it — gated on `recompileDropsWebGPUGridState(msg)` so a
  cache-hit recompile still costs nothing. `webgpuShaderMatchesRuntime()` is now the ONE definition read
  by both the pipeline cache and that gate. Full invariant:
  [`docs/areas/simulation-engine.md`](areas/simulation-engine.md) → *A `recompile` that rebuilds a GPU
  runtime must read the GPU down first*.
- **Evidence, same protocol either side of a `git stash`** (Game of Life / WebGPU, board sampled with
  `requestColorsSnapshot`, which reads the GPU and does **not** refresh the attr mirror — a `getState`
  probe would have masked the bug): mirror synced at gen 20, board stepped to gen 59, one constant edited
  in the macro through the real UI → **before: board = the gen-20 board, hash `2330622239` / 322 lit
  (was `2342589582` / 393 lit an instant earlier); after: board unchanged, `2342589582` / 393 lit.**
  Same result for the Simulator-tab route. Post-fix re-verified on: GoL with a brush stroke mid-run
  (board and stroke both survive), **On demand** + `Ctrl+Enter` (0 posts while Pending, 1 recompile on
  apply, board preserved), **Life3D** (voxel WebGPU, `Aggregate sum → average`, board preserved),
  **Particle Life** (2000 agents GPU-resident, agent x-positions keep advancing — no regression on the
  agent one-shot), and the structural path unchanged (adding a cell attribute → `⟳ Rebuild needed` →
  Apply → exactly one worker swap, gen 0). 0 console errors throughout.
- Gates: `tsc -b`, `npm run build`, `check-compile-identity --compare` (**31 models, all surfaces
  unchanged**), `parity-agent-wasm`, `verify-agent-render`, `verify-sparse-stepping --wasm`,
  `check-claude-md-budget` — all green.

**What Phase 4 inherits.** `liveState.ts` now carries `liveShown` (already published by `App`) and the
`LiveRuleStatus` type; `liveFocus` / `liveGraphDragging` are still to come. The chip and the
apply-policy switch sit on the LEFT of the Live viewport bar, before the Settings / Controls / Layout
buttons, so a focus ring or further bar controls have room. Nothing in Phase 3 touches the keyboard
except the new capture-phase `Ctrl+Enter`, which is registered only while `live` is true and stands down
for `TEXTAREA` / `contentEditable` / the capture-review modal — Phase 4's stand-down set should be
applied to it too if it grows (the quick-add and connection-drop menus own `Enter`, not `Ctrl+Enter`).

---

# Phase 4 — Input ownership and guards

**Goal:** exactly one surface owns each keystroke; `Esc` never resets in Live; the Overseer and Live
cannot collide; the perf guards are in.

**This phase also fixes two pre-existing bugs** that exist today, with or without Live:
`Esc` in the Modeler resets the running simulation, and `Ctrl+C/V/X` is bound twice in the same phase on
the same target. See impact map §6, Findings 1 and 2.

## 4.1 Focus ownership

- `liveState.liveFocus: 'graph' | 'viewport'`, set on `pointerdown` (and `pointerenter`, so hovering is
  enough to type) inside each pane.
- Rendered as a **1 px accent inset ring** on the focused pane (`--color-accent`). Only in Live.
- Persisted per session only (not to localStorage) — it is a transient.

## 4.2 The two pre-existing fixes

**Fix A — gate `SimulatorView`'s main keyboard handler (`:13503-13741`).** Insert, right after the
existing field check and `captureReviewRef` check:

```ts
if (!visibleRef.current) return;                       // never act while the view is hidden
if (liveShownRef.current && getLiveFocus() !== 'viewport'
    && !isGlobalLiveKey(e)) return;                     // in Live, only the focused surface
```

`isGlobalLiveKey` covers exactly `Enter` (global play/pause). Everything else — `Space`, the 3D numpad
digits, `Ctrl+C/V/X` — becomes viewport-focused.

Then, still inside the handler, in Live:
- `Esc` and `Backspace` **must not reach `handleReset()`** (`:13737`). Keep the staged-line-anchor arm
  (`:13729-13736`) — cancelling a staged line is a viewport action and is safe. Reset stays the ■ button.
- `Space` → `handleStep()` only when focus is `viewport`.

**Fix B — resolve the `Ctrl+C/V/X` double binding.** `GraphEditor.tsx:3890` and
`SimulatorView.tsx:13739` both bind them, bubble phase, on `document`, with only a field check. In Live,
each must consult `getLiveFocus()`. Outside Live, `SimulatorView`'s arm is gated by Fix A's
`visibleRef` check, which alone removes the Modeler-side misfire (including the invisible 3D
`showAgentNotice` toast at `:13521-13526`).

⚠ **`isContentEditable` is missing from the simulator's field check** (`:13505`) while the modeler's has
it (`ModelerView.tsx:266-267`). Align them in this phase.

## 4.3 `Space` · `Enter` · `Esc` · `F` in Live

| Key | Rule | Implementation |
|---|---|---|
| `Space` | focused surface | `ModelerView.tsx:280-291` already claims it capture-phase with `stopImmediatePropagation()`. In Live it must **stand down when focus is `viewport`**, letting `SimulatorView`'s arm run. |
| `Enter` | **global play/pause**, unless a field / menu / dialog has focus | keep it in `SimulatorView`'s handler as `isGlobalLiveKey`; extend the stand-down set beyond `INPUT/TEXTAREA/SELECT` to the quick-add + connection-drop menus (`GraphEditor.tsx:5280-5283` owns `Enter` there), `NameInputDialog`, `ConfirmDialog`, `SpriteSheetDialog`, `SpriteCropDialog`, the capture-review modal |
| `Ctrl+Enter` | apply now (Phase 3) | capture-phase on `document`; same stand-down set |
| `Esc` | closes a menu if one is open, else **nothing**. Never resets. | the existing armed-state `Esc` handlers (`GraphEditor.tsx:1520`, `:5153`, `:5284`; `SimulatorView.tsx:2545`, `:2627`, `:3714`, `:13060`) already `stopPropagation` in their armed states and are unchanged |
| `Backspace` | same as `Esc` | **easy to miss** — it shares the reset arm at `:13737` |
| `F` | collapses **both** | dispatch `genesis-toggle-canvas-fullscreen` **once**; both consumers already listen (`ModelerView.tsx:236-240`, `SimulatorView.tsx:15114-15117`, the latter `visibleRef`-gated = shown = true in Live). The two *direct* key handlers (`ModelerView.tsx:275-279` and `SimulatorView.tsx:15098-15112`) must stand down in Live so the key is handled once, not three times. |
| `Ctrl+Z / Shift+Z / Y / D` | graph only (the run is not undoable) | unchanged |
| digits `1-9` | viewport-focused only (3D view angles, `:13706-13726`) | covered by Fix A |
| `?` | unchanged (`App.tsx:169-180`) | — |

## 4.4 Overseer ↔ Live, both directions

- **Live → Overseer:** `handleRunExperiment` (`:3522`) early-returns while `liveShown`. The Experiments
  **tab strip is hidden** in Live and `rightPanelTab` is coerced to `'controls'` — the exact shape of the
  existing fallback effect at `:14993`.
  *Why hide, not grey:* an experiment structurally cannot run in Live (every graph edit aborts it via
  `:8944`), and the user cannot reach the working state from that panel.
- **Overseer → Live:** the **Live nav button is disabled in place**, `title` =
  *"An Overseer experiment is running — abort it or wait for it to finish."*
  *Why grey, not hide:* the Abort button is visible in the Experiments panel, so the working state **is**
  reachable — the documented "one setting away" case (and the direct sibling of the doctrine's own
  *"the Overseer's Run button mid-experiment"* example).
- `App` needs the predicate. Publish `overseerRunning` through `liveState` (set alongside
  `setOverseerRunning` at `:3616` / `:3622-3623` — **the mirror-invariant discipline: assign the module
  flag in the same statement as the React state**, so they can never disagree).
- A model with `overseerConfig.enabled !== true` never sees any of this (`overseerEnabled`, `:3505`).

## 4.5 Perf guards

- **FPS cap 30 as the Live default.** On first Live entry of a session, if `targetFps > 30`, snapshot the
  previous value and set 30; restore on exit. The FPS popover stays fully live — **it is a default, not a
  clamp** (an overridden-but-enabled control is what the doctrine forbids).
- **Skip the blit, not the step, during a node drag.** Guard the per-`stepped` `draw()` at `:7629` with
  `liveState.liveGraphDragging`. Keep the `setGeneration` throttle (`:7625-7628`), the whole recording
  block (`:7664+`) and `sendNextStep()` (`:7833`) running.
  ⚠ **Do not route this through the unlimited-gens fast path** (`:7604-7620`) — it skips the colour pass
  and carries its own voxel-free-mode carve-out.
  The drag signal already exists: `GraphEditor.tsx:1955-1956` computes `isDrag` / `isDragEnd` from the
  position changes; publish it to `liveState`.
  On drag end, draw once immediately so the last frame is not stale.

## 4.6 UI-doctrine disposition (Phase 4 controls)

| Control | Disposition |
|---|---|
| **Live** nav button | **grey + reason** while an Overseer experiment runs |
| Experiments tab strip | **hidden** in Live (+ state coercion to `'controls'`) |
| Focus ring | not a control — a 1 px indicator, no pointer events |
| FPS popover in Live | fully live (Live sets the default only) |
| Layout menu items | **grey + reason** while recording (the frame dims are locked on the first frame — `recordCropRef`, `:2979`) |

## 4.7 Verification recipe

- `npx tsc -b` · `npm run build` · `check-compile-identity --compare` → all surfaces unchanged.
- **The pre-existing bug, before and after.** *Before the fix:* in the **Modeler**, with Game of Life
  playing, press `Esc` → the generation counter drops to 0. *After:* it does not. Same for `Backspace`.
  Same for `Enter` (before: one `step` batch is posted — spy on `postMessage`; after: none).
- **`Ctrl+V` isolation in Live:** copy nodes in the graph, focus the graph, `Ctrl+V` → nodes pasted and
  **no `writeRegion` / `pasteAgents` message posted**. Then focus the viewport, copy a cell region,
  `Ctrl+V` → cells pasted and **no nodes added**.
- **`Enter` globality:** with focus in the graph, `Enter` toggles play. With focus in a node's text field,
  it does not. With the quick-add menu open, `Enter` commits the menu item and does not toggle play.
- **`F`:** one press collapses both panel sets; a second restores both to their previous state (including
  entries that were already closed).
- **Overseer both ways:** on **GoL Replicate Statistics**, start an experiment → the Live nav button is
  greyed with the reason. Abort → it re-enables. Enter Live → the Experiments tab strip is gone and
  `rightPanelTab` is `'controls'`.
- **Skip-blit:** Particle Life, playing, in Live. Spy on `draw` (or count `drawImage` calls). During a node
  drag: **0 scene draws**, while the generation counter (worker `stepped`) keeps advancing. On release:
  one draw.
- **FPS cap:** entering Live drops the cap to 30 (visible on the FPS chip); raising it in the popover
  sticks; leaving Live restores the pre-Live value.
- **3D:** repeat the keyboard matrix on **Life3D** — especially that digits `1-9` change the view **only**
  when the viewport has focus, and do nothing while typing in the graph.
- **0 console errors.**

## 4.8 Phase 4 — AS BUILT, and where it deviates from §4.1–4.7 (2026-09-07)

Phase 4 shipped. `tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`check-compile-identity --compare` (**31 models, all surfaces unchanged**), `parity-agent-wasm.mjs` and
`verify-agent-render.mjs` are green; `git diff --stat` touches **no file** under
`src/modeler/vpl/compiler/**` or `src/modeler/vpl/nodes/**`, and `sim.worker.ts` has **no diff at all**.
Reference documentation: [`docs/areas/simulator-ui.md`](areas/simulator-ui.md) § *LIVE mode — INPUT
OWNERSHIP and the perf guards*, [`docs/areas/modeler-ui.md`](areas/modeler-ui.md) § *LIVE mode — the graph
pane's INPUT OWNERSHIP*, [`docs/areas/overseer.md`](areas/overseer.md) § *Overseer ⇄ LIVE mode*, plus a
line in [`grid-3d.md`](areas/grid-3d.md) (the numpad keys) and the two new files in
[`project-structure.md`](areas/project-structure.md).

| § | Planned | As built | Why |
|---|---|---|---|
| 4.2 Fix A | `if (!visibleRef.current) return;` unconditionally | `if (!visibleRef.current && !globalLiveKey) return;` | With the Live viewport COLLAPSED (Phase 2's `display: none` + `visible: false`) `live` is still true and the run still advances — and that state exists precisely so the user can work on the graph alone. Refusing `Enter` there would remove the only way to stop a running simulation without changing the layout. Verified: collapsed, gen 540 → 567, `Enter` pauses and resumes, `Space` posts nothing. |
| 4.3 `Enter` | stand-down set = `INPUT/TEXTAREA/SELECT` + menus + dialogs | **`SELECT` is NOT in it** (INPUT / TEXTAREA / contentEditable / `[role=dialog]` / `[role=menu]` / the capture-review modal are) | A `<select>` KEEPS FOCUS after a pick and picking an option in a node is the commonest Live edit — the same finding Phase 3 recorded for `Ctrl+Enter` (§3.7). `Enter` has no native meaning in a closed dropdown, and while its popup is open the browser does not dispatch the key to the page at all. Every other key still stands down on `SELECT`. |
| 4.3 `F` | "dispatch the event once; both consumers already listen" | The event carries **`detail.collapse`**, a SHARED intent flipped by `dispatchCanvasFullscreen()`; both consumers obey it, and both `⛶` buttons go through the same dispatcher | Two independent toggles are permanently OUT OF PHASE in Live: the panel policy enters with the graph's panels closed and the simulator's bars open, so one press would OPEN one while CLOSING the other — the plan's own acceptance test ("one press collapses both, a second restores both") is unreachable without an intent. Also required a snapshot fix in BOTH views: an explicit `collapse: true` arriving with nothing open must not overwrite the existing snapshot, or the matching restore is a permanent no-op. |
| 4.3 | the stand-down set is a list of components to special-case | One shared predicate, **`overlayOwnsKeyboard()`** in the new [src/live/liveKeyboard.ts](src/live/liveKeyboard.ts) — a DOM probe for `[role="dialog"], [role="menu"]` — applied to the simulator's main handler, its `F` handler, `Ctrl+Enter` and `ModelerView`'s handler | The surfaces are written by six components but every one already renders ONLY while open, so presence in the DOM IS the signal, and `role` is the correct ARIA regardless. It also had to be DOM-based, not focus-based: the quick-add menu focuses its search input on a **50 ms timer**, which is exactly the window in which `Enter` arrives. Nine modals in `src/components` gained `role="dialog"` and `GraphEditor`'s context menu `role="menu"`. It fixes one more pre-existing misfire: `Enter` on a `ConfirmDialog` used to confirm the dialog AND toggle play. |
| 4.5 FPS | "restore on exit" + "on first Live entry of a session" | Restored on exit **only if the user did not move the FPS control while in Live**; if they did, their value stands and Live never auto-lowers again this session | D11 says it is a default, not a clamp. Silently undoing a value the user set inside Live (or re-lowering it on every entry) is the clamp wearing a different hat. ⚠ The override test needs an explicit SETTLE step — the effect's deps include `live`, so it also runs in the commit where the entry effect only *scheduled* the drop to 30, and latching there makes the default never apply at all (observed, and silent). |
| 4.5 skip-blit | `liveState.liveGraphDragging` read by the `stepped` handler | Read through a **subscription into a ref**, not `useSyncExternalStore` | A `useSyncExternalStore` read would re-render this 18 kloc component twice per drag gesture for a flag only the step loop consults. The subscription's falling edge is also where the single immediate redraw happens. |
| 4.5 skip-blit | gate the per-`stepped` `draw()` | …**and its direct-render rAF follow-up** | Under direct render the follow-up is a second blit per step; gating only the first halves the saving instead of taking it. Also cleared from `GraphEditor`'s unmount cleanup (an interrupted gesture emits no `dragging: false`). |
| — | *(not in the plan)* | The transport titles are Live-aware: **Reset (Esc)** → *Reset*, **Step (Space)** → *Step (Space — with the viewport focused)* | A tooltip that names a key the control no longer answers to is worse than one that names none — and `Esc` no longer resets in Live. |
| — | *(not in the plan)* | A DEV-only `window.__setLiveGraphDragging` hook in `liveState.ts` | A React Flow node drag cannot be driven by synthetic pointer events (the Phase-2 note), so the skip-blit guard would be unverifiable otherwise. It drives the exact flag the real gesture publishes. |

**Measured results** (all in the real app, real worker, real GPU, 0 console errors):

- **The pre-existing bug, A/B on the same tree** (Phase-3 `SimulatorView.tsx` stashed, reproduced,
  restored): in the **Modeler**, `Enter` posted a `step` and moved gen 250 → 251, `Esc` posted `reset` and
  gen → 0. After: `Enter` / `Esc` / `Backspace` / `Space` → **0 posts, gen unchanged**.
- **Live, Game of Life:** graph focus `Space` → quick-add, 0 steps; `Esc` → menu closed, 0 resets, gen
  climbing 259 → 306. Viewport focus `Space` → exactly 1 step; `Esc` and `Backspace` → 0 resets. `Enter`
  toggles play from both panes; inside the quick-add search input it adds the node and does **not** toggle;
  with a node's `<select>` focused it **does**. `Ctrl+Z` undoes from either focus.
- **Clipboard routing:** graph focus → node pasted, 0 `writeRegion`/`pasteAgents`; viewport focus over the
  board → 1 `readRegion` + 1 `writeRegion`, 0 nodes added.
- **`F`:** with a modeler panel and the sim bars open, press 1 → graph area 444 → 764 px + the transport
  down to its bare ear; press 2 → both exactly restored.
- **Overseer:** Run on `GoL Replicate Statistics` → the Live nav button disabled with the reason; Abort →
  enabled; in Live no tab strip and no Run Experiment button.
- **FPS:** 61 → Live 30 → back on the Simulator tab 61; raised to 45 inside Live → 45 on exit and on
  re-entry.
- **Skip-blit, 1.5 s playing windows:** Game of Life 79 blits / 39 steps normal → **0 blits / 40 steps,
  gen +42** dragging → 5 blits within 60 ms of release. Particle Life (GPU-resident direct render):
  80 → **0** → 5, with **0 `attachAgentCanvas`** during the drag.
- **3D (Life3D):** numpad digits produce 0 GL draws with the graph focused and 4 with the viewport
  focused; a real orbit drag in the Live pane works (8 GL draws, view changed).
- **Simulator tab unchanged:** `Esc` still resets (1 `reset`, gen → 0), `Space` still steps.

**What Phase 5 must document** (shortcut tables — `HelpView.tsx` `#help-shortcuts` and
`KeyboardShortcutsOverlay.tsx`'s `GROUPS`):

- A new **Live** group: `Enter` = play/pause **globally** (either pane) · `Ctrl+Enter` = apply now ·
  `Space` = the focused pane (quick-add / step) · `Esc` **never resets in Live** (it dismisses menus) ·
  `Ctrl+C/V/X` = the focused pane · `Ctrl+Z/Y/D` = the graph, from either pane · `F` = collapses BOTH
  panel sets · digits `1-9` = 3D view angles, viewport focus only.
- The **Simulator** group is unchanged on its own tab, but the note "Esc resets" now needs
  "…on the Simulator tab; in Live, Reset is the ■ button".
- Worth a sentence in Help: **focus follows the pointer** (click or hover) and the focused pane carries a
  1 px accent ring.

**Left for Phase 6** (unchanged): the Document Picture-in-Picture spike. Nothing in Phase 4 constrains it,
except that a PiP viewport pane would need its own `liveFocus` source (the pane wrapper it currently hangs
off would no longer be under the pointer).

---

# Phase 5 — Documentation and the verification sweep

**Nothing here is optional.** The *Documentation consistency* rule treats these as one atomic update.

## 5.1 Every doc layer

| Layer | What to add |
|---|---|
| **Code comments** | The `shown` vs `activeTab` split at `SimulatorView.tsx:2276` and `:10693`; the last-good-rule intercept in the model effect; the `appliedModelRef` rule; the `simLayoutApi` registration; each new module's header comment in the house style (what it is, why a module global, what breaks without it) |
| `docs/areas/simulator-ui.md` | A new section: the `shown`/`activeTab` split and what each gates · the Live panel policy + the `preLivePanelStateRef` leak trap · the Live viewport bar and its `data-sim-overlay` requirement · the capture ↔ layout interlock · **the trap that the main keyboard handler was ungated and what now gates it** |
| `docs/areas/modeler-ui.md` | The Live pane · the keyboard-owner rule and the resolved `Ctrl+C/V/X` double binding · that React Flow self-resizes so the splitter needs no modeler plumbing · **that panel widths do NOT persist** (the assumption that misled the brainstorm) |
| `docs/areas/overseer.md` | The Live exclusion, both directions, and why (`:8944` aborts on any model change) |
| `docs/areas/grid-3d.md` | The 3D Live pane: the layered canvas stack in a narrow box, the camera re-send on entry, the occluded-pane verification traps |
| `docs/areas/simulation-engine.md` | One line: Live adds **no** worker message; the four present-only messages simply fire on a new trigger |
| `docs/areas/indicators.md` | The Live indicators popover and the mount-at-width-0 trap |
| **`docs/areas/project-structure.md`** | **New source files** (`src/live/liveUiState.ts`, `src/live/liveState.ts`, `src/live/LiveSplitter.tsx`, `src/live/LiveViewportBar.tsx` + CSS modules, `src/simulator/simLayoutState.ts`) **and the three planning docs** (`IMPACT_MAP_LIVE_SPLIT.md`, `PLAN_LIVE_SPLIT.md`, `PLAN_LIVE_SPLIT.html`) in the `docs/` block at `:182-186` |
| **`CLAUDE.md`** | **A routing-table ROW only** if Live warrants its own area doc; otherwise **nothing**. Live detail must not become a CLAUDE.md section (`node scripts/check-claude-md-budget.mjs` enforces 600 lines / 60 KB) |
| `src/help/HelpView.tsx` | A **Live** subsection — put it after `#help-simulator` (`:4190`) or as its own `#help-live` section, and update `#help-shortcuts` (`:5048`) |
| `src/components/KeyboardShortcutsOverlay.tsx` | A new **"Live"** group in `GROUPS` (`:18-71`): `Enter` global play/pause · `Ctrl+Enter` apply · `Esc` never resets · `F` collapses both · `Space`/`Ctrl+C/V/X` follow the focused surface. Also correct the **Simulator** group if the `Esc` behaviour changed there. |
| `README.md` | The `### Interact while it runs` group (`:161`) gains **one clause**, not a paragraph — the Features section is deliberately high-level. Optionally a `docs/Gifs/live.gif`. |
| `docs/NODES_REFERENCE.md` | **Nothing.** No node changed. Say so in the phase report rather than leaving it ambiguous. |

## 5.2 The gate run

```bash
npx tsc -b
npm run build
node scripts/check-claude-md-budget.mjs
node scripts/check-compile-identity.mjs --compare <baseline from before Phase 2>
node scripts/parity-agent-wasm.mjs
node scripts/verify-agent-render.mjs
node scripts/verify-sparse-stepping.mjs --wasm
node scripts/test-agent-capabilities.mjs
node scripts/test-bonds-allocation.mjs
```

`check-compile-identity` must read **"31 models, all surfaces unchanged"**. That is the headline claim for
this whole feature — Live is presentation, mounting and input ownership.
**No new emitted surface is introduced, so nothing is added to that harness's surface list.**

## 5.3 The live UI pass (2D · 3D · agents), 0 console errors

| Model | What it proves |
|---|---|
| **Game of Life** (2D grid, WebGPU) | the core loop: enter Live mid-run, edit, last-good-rule, rebuild prompt, splitter, all four layout actions |
| **Wireworld (expanded)** | a large 2D graph in a half-width pane: minimap, `F`, scrolling |
| **Life3D** (3D voxel) | the 3D canvas stack in a narrow pane, camera re-send, numpad ownership, voxel re-attach count |
| **Accretor** (300³, WebGPU voxel free mode) | that `stepped` still ships no colours in Live, and the splitter costs ≤ 2 attaches |
| **Particle Life** (2D agents, GPU-resident direct render) | the A1 direct-render re-attach path and the skip-blit guard |
| **Particle Life 3D** | 3D agent spheres + orbit input in a narrow pane |
| **Growing Tissue** (agents-only) | no CA layer: the brush popover hides, the pane still sizes |
| **Chemotaxis** (both topologies, E2 composite) | the composite blit under a splitter drag |
| **GoL Replicate Statistics** (Overseer) | the mutual exclusion, both directions |
| Any model **inside a macro scope** | editing inside a macro while it runs is the same pipeline |

Also: reload with a persisted Live layout; enter Live from each of Modeler / Simulator / Library; leave
Live to `help` and back (the run must auto-pause on `help` — `activeTab` and `shown` are both false there).

## 5.4 Phase 5 — AS BUILT (2026-09-07)

Phase 5 shipped. **All gates green:** `npx tsc -b`, `npm run build`,
`check-compile-identity --compare` (**31 models, all surfaces unchanged** — the headline claim for the
whole feature, re-run before AND after the phase's edits), `parity-agent-wasm`,
`check-claude-md-budget` (308/600 lines, 27.8/60 KB), `test-macro-references`, `verify-agent-render`,
`verify-sparse-stepping --wasm`, `test-agent-capabilities` (204), `test-bonds-allocation` (19).
**`docs/NODES_REFERENCE.md` was NOT touched, deliberately: no node, port or emit changed.**

| Layer | As built |
|---|---|
| `src/help/HelpView.tsx` | A new **`#help-live`** section (its own TOC entry, between the Simulator and the shortcuts) covering what Live is, the mounting promise (no restart on a mode switch), the layout menu + persistence + the recording interlock, the panel policy, a 4-row **chip table** (Synced / Stale / Pending / Rebuild needed), the apply policy + `Ctrl+Enter`, "the chip is only about your graph" (imports still raise the red banner), focus-follows-the-pointer + the ring, and the two gotchas (FPS 30 default · Overseer exclusion). `#help-shortcuts` gained a **Live Mode** table (9 rows) and its Simulator `Esc` row now says "on the Simulator tab; in Live, Reset is the ■ button". Cross-links added from the Simulator intro, the Playback/Recompile bullet and the Overseer Experiments paragraph. |
| `KeyboardShortcutsOverlay.tsx` | A new **`Live — edit while it runs`** group (`wide`), 10 rows, plus the same `Esc` qualification on the Simulator group. |
| `README.md` | One sentence added to **`### Interact while it runs`** — no new group, no inventory. |
| `docs/areas/README.md` | Six stale sizes refreshed (`simulator-ui` 100→137 KB is the big one) and the `covers` blurbs for `simulator-ui` / `modeler-ui` / `overseer` now name Live. |
| `CLAUDE.md` | Two lines: "Two coexisting modes" → three (Live named), and **one routing row** for `src/live/**` → `simulator-ui.md` § *LIVE mode*. No Live section — the budget check stays green. |
| `docs/areas/project-structure.md` | **Already complete** — all 7 `src/live/*` files, `simLayoutState.ts` and the three planning docs were entered by Phases 2–4. No edit needed. |
| `docs/areas/indicators.md` | One bullet: the Live overlay panel, and why it is the SAME panel rather than a second popover copy (every chart measures its own box; a second mount, or one inside a `display:none` pane, sizes a canvas at width 0). |

**Stale statements found by the audit, and where** (all fixed):

| Statement | Where | Now |
|---|---|---|
| "**Esc** → Reset", unqualified | `HelpView.tsx` shortcuts table · `KeyboardShortcutsOverlay.tsx` `GROUPS` | qualified with "Simulator tab only — in Live, Reset is the ■ button" |
| "**Two** Application Modes … Both modes coexist" | `docs/areas/architecture.md` | Three, with the D1 mounting invariant stated in one line and links to both LIVE sections |
| "the **two** work modes Modeler / Simulator" | `docs/areas/modeler-ui.md` (navbar layout) | three, `LIVE_ICON` described, and the note that Live is the only nav button that can be DISABLED |
| the cheat sheet "grouping the Global / Modeler / Simulator shortcuts" | `docs/areas/modeler-ui.md` (discoverability) | + Live + 3D, with the `Esc`-row rule recorded as an invariant |
| "both dispatch a bare `genesis-toggle-canvas-fullscreen`" | `docs/areas/modeler-ui.md` (same bullet) | + the pointer to the shared `detail.collapse` intent Live needs |
| "**Two coexisting modes** in one app" | `CLAUDE.md` | three, + "a mode switch never restarts the run" |
| "they are **mutually exclusive**: switching to the Modeler unmounts the simulator UI and auto-pauses the run" | `docs/BRAINSTORM_SEE_THROUGH_CANVAS.md` | a **status banner** at the top marking the doc as the point-in-time origin record, naming the two claims that are now false and pointing at the impact map's § 16 |

`docs/NODES_REFERENCE.md` was grepped for mode behaviour and carries **none** — nothing to change.

### The defect the UI pass found (and fixed): a RESTORE was read as a user override of the Live FPS default

`applySimulationState` wrote `state.targetFps` / `state.unlimitedFps` straight into state. It runs on a
**structural Apply that re-seeds from a saved board**, a `.gcastate` load and a board-carrying preset —
so a Live rebuild silently put the cap back to the model's saved value (**measured: FPS 30 → 61 the
instant Apply landed**) *and* the "did the user move it" detector latched on that change, so Live never
auto-lowered again for the session. The fix, in that one funnel: while Live is holding its default, a
restored cap goes into the **snapshot** (`preLiveFpsRef` — what is restored on exit), not into live
state. Zero compiler/emit surface; documented in
[`areas/simulator-ui.md`](areas/simulator-ui.md) § *Perf guard 1*. **Re-verified on Game of Life and
Life3D:** rebuild → Apply → 1 `terminate`, gen 0, chip **FPS 30**; leaving Live still restores 61.

### The live UI pass — what was actually observed

**Game of Life (2D grid, WebGPU).** Enter Live mid-session → same worker, `● Synced`, FPS 30.
`Enter` **from the graph pane** started the run (gen 0 → 82). Benign edit (`Set Alive` True → False)
→ **1 `recompile`**, chip stayed `Synced`, gen 2934 → 2971 climbing, and the board really changed —
it went extinct but for the still-lifes. `Ctrl+Z` from graph focus → 1 `recompile`, restored.
**Break** (clear the `Set Attribute` attribute) → `● Stale`, **0 `recompile`**, gen 4981 → 5057 still
climbing, **no red banner**; re-select → exactly **1 `recompile`**, `● Synced`. **Structural:**
+1 cell attribute → `⟳ Rebuild needed`, 0 terminates, gen 5734 → 5811 climbing; **Later** → bare chip;
a SECOND attribute → still one prompt, still 0 posts (the Trap-C check); click the chip → Apply/Later
back; **Apply** → exactly **1 terminate**, gen 0, `● Synced`. **On demand** → edit → `● Pending`,
**0 posts**; `Ctrl+Enter` → **1 `recompile`**, `● Synced`.
**Layout:** dock bottom (panes 1694×402 stacked, canvases resized to match) · swap (graph to the
bottom) · collapse (single pane, restore ear present) · restore · dock right · **30-move splitter drag**
→ panes 613/1075 with **0 canvas/box mismatches** at rest and **0 worker posts** during the drag,
fraction committed as `0.363` on release · **double-click → exactly 50/50**.
**Keyboard:** graph focus + `Space` → quick-add opened, **0 step posts**; `Esc` → menu closed,
**0 resets**; viewport focus + `Space` → **exactly 1 step** (gen 0 → 1); `Esc` and `Backspace` there →
**0 resets**; `Enter` toggled play from **both** panes; **`F`** → graph area **124 → 764 px** and the
simulator's viewer bar hidden, second press restored **both** exactly.
**Exit:** to the Simulator tab — **same worker object**, gen 56 preserved, no chip, no viewport bar,
**FPS back to 61**; then the Modeler — `Enter` / `Esc` / `Backspace` posted **0** and gen never moved
(the pre-existing defect stays fixed), while `Space` still opened the graph's quick-add.

**Life3D (3D voxel).** Live entry rendered the voxel stack in the half-width pane with the 3D View
panel clear of the viewport bar. **3D digit ownership: 0 `setGridCamera` with the graph focused, 1 with
the viewport focused.** Break (clear `Set Attribute`) → `● Stale`, **0 `recompile`**, gen 652 → 714;
fix → **1 `recompile`**, `Synced`. **30-move splitter drag while playing → exactly 1
`attachVoxelCanvas`** and, once settled, canvas backing stores **exactly** equal to their CSS boxes
(the mismatches sampled DURING the drag are an artefact of reading before the rAF, not a defect).
Structural rebuild via `Ctrl+Enter` → **1 terminate**, gen 0, voxels rendering, FPS still 30.

**Particle Life (2D agents, GPU-resident direct render).** Deleting the **Behaviour Step** node →
`● Stale`, **0 `recompile`**, gen 1071 → 1139, and two screenshots two seconds apart show the
population in **visibly different configurations** — the agents kept moving on the last good behaviour;
`Ctrl+Z` → **1 `recompile`**, `Synced`. **Skip-blit guard** (via the DEV `__setLiveGraphDragging` hook,
1.5 s windows): normal **76 blits / 38 steps** → dragging **0 blits / 39 steps, gen +39**, with **0
`attachAgentCanvas`** → release **7 blits within 80 ms**.

**GoL Replicate Statistics (Overseer).** Run Experiment → the **Live nav button DISABLED** with the full
reason in its `title`; **Abort** → enabled again. Inside Live: **no `Overseer Experiments` tab and no
`Run Experiment` button** anywhere in the DOM.

**Persistence.** With `{dock: bottom, swapped: true, viewportCollapsed: true}` in
`genesisca_live_layout`, a **full page reload** came back to exactly that layout — graph filling the
window, restore ear in the splitter's slot, FPS 30 applied, `● Synced`.

**Help.** The new `#help-live` section, its chip table, the `Live Mode` shortcut table and the overlay's
`Live — edit while it runs` group were all read back from the rendered DOM and screenshotted.

**0 console errors across the entire pass** (`window.onerror` + `unhandledrejection` + a `console.error`
hook installed before every model). ⚠ Two verification-only artefacts, NOT app defects, worth recording
for the next session: (1) a synthetic `MouseEvent`/`PointerEvent` **without `view: window`** makes a
handler throw `Cannot read properties of null (reading 'document')` — always set `view`; (2) this
harness cannot deliver `Space` (it arrives as `key: ""`, and `e.code` is empty for every key), so
`Space` and the 3D digits must be driven with a hand-built `KeyboardEvent({key, code})`.

**Left open for Phase 6** (unchanged): the Document Picture-in-Picture spike, still feasibility-gated,
still needing its own `liveFocus` source for a popped-out viewport pane. Nothing in Phase 5 constrains
it. One cosmetic pre-existing nit noticed while proof-reading Help and deliberately NOT swept here (it
is everywhere in the file and unrelated to Live): a `</strong>` at end-of-line followed by a word on the
next line loses the space in JSX — the three occurrences inside the NEW Live copy were fixed with
`{' '}` and the rendered text re-read to prove no glued words remain.

---

# Phase 6 — FUTURE PHASE: pop the Live viewport out to an OS window (Document PiP)

**Feasibility-gated. This phase may end in a written deferral, and that is an acceptable outcome.**

> ## ⛔ STATUS (2026-09-07): the spike RAN, and the phase is DEFERRED. **No `src/**` change was made.**
>
> The spike's own question — *do the four display surfaces keep presenting after being moved into the
> PiP document, and return cleanly?* — is now answered, in a real Chrome, on a real GPU: **YES, on all
> four, with no context loss, no attach storm and a clean return.** That is not the reason for the
> deferral.
>
> The spike found a **different** blocker the protocol did not ask about: **a Document PiP window is a
> separate `Window` and `Document`, and it does not propagate events to its opener.** `SimulatorView`
> registers **36** listeners on the opener's `window` / `document`, including every key the Phase-4
> contract depends on. Measured with real trusted input inside the PiP window: **`Enter` does not
> play/pause, `Space` does not step, a drag on the board does nothing.** Only the wheel survives,
> because its listener is on the container element, which travels with the DOM.
>
> §6.1's gate is *"all six pass ⇒ build; any of them flaky ⇒ defer"*, and a viewport whose keyboard and
> drag input are dead is flaky by any reading. **Read [§ 6.4](#64-phase-6--the-spike-as-run-the-measurements-and-why-this-is-deferred-2026-09-07)
> before attempting this phase again** — it is a measurement, not an opinion, and it names the work
> §6.2 does not scope.

## 6.1 The spike (do this first, in isolation, before any product code)

`documentPictureInPicture.requestWindow()` gives an always-on-top window the page fully controls
(Chromium only — acceptable: WebGPU already requires it) and needs a user gesture. The question is
whether **the display canvases keep presenting after being moved into that document, and return cleanly
on close.** Four surfaces, and they fail differently:

| Surface | Element | Risk |
|---|---|---|
| 2D display | `canvasRef` (`SimulatorView.tsx:15537`) | a plain 2D canvas: `adoptNode` is expected to be fine, but the 2D context may be re-created and the bitmap lost — must be measured, not assumed |
| 2D cursor overlays | `cursorHlCanvasRef`, `cursorNegCanvasRef` (`:15564-15567`) | `mix-blend-mode: difference` depends on the stacking context — must be re-verified in the PiP document |
| 3D | `glCanvasRef` (`:15557`) | **WebGL2 context loss** on document adoption is a real possibility; if it happens, gl3d must handle `webglcontextlost`/`restored` or the phase is dead for 3D |
| **worker-presented `OffscreenCanvas` placeholders** | the canvases appended imperatively into `agentSphereLayerRef` / `voxelLayerRef` (`:15545`, `:15550`) | **the hard one.** Control was transferred to the worker; whether presents keep landing after the placeholder is adopted into another document is unspecified and must be tested on a real GPU |

**Spike protocol** (a throwaway branch, no product code):
1. Particle Life (2D agent direct render) → pop out → assert the canvas keeps advancing (sample the
   worker's `stepped` count and the canvas pixels) for ≥ 30 s.
2. Accretor (voxel free mode) → the same.
3. Life3D (gl3d WebGL2) → the same, plus orbit input inside the PiP window.
4. Game of Life (plain 2D blit) → the same.
5. Close the PiP window → every canvas returns to the main document and keeps presenting; **no leaked
   attaches, no dead contexts, no console errors**.
6. Resize the PiP window → the re-attach path runs exactly as it does for the splitter (≤ 2 attaches per
   gesture).

**Gate:** all six pass ⇒ build. Any of them is flaky ⇒ **defer, and write the finding into
`docs/areas/agent-render.md` and this plan** so the next attempt starts from the measurement rather than
from the idea.

## 6.2 If it passes

- A **Pop out** button on the Live viewport bar. **Hidden** where `window.documentPictureInPicture` is
  undefined — structurally impossible, so hide, do not grey.
- While popped out: the Live layout collapses to the graph alone (`viewportCollapsed`-like), and the
  layout menu items that move the viewport are **greyed with the reason**.
- Closing the PiP window (by the user or by the OS) must restore the split — listen for `pagehide` on the
  PiP document, restore before the next paint.
- The `simLayoutApi` seam is reused verbatim: the PiP window's resize drives `scheduleLayoutDraw`.
- Copy every CSS custom property into the PiP document (it does not inherit the opener's stylesheets), or
  the viewport bar renders unthemed.

## 6.3 Verification

The spike protocol above, re-run against the shipped implementation, plus:
`npx tsc -b`, `npm run build`, `check-compile-identity --compare` (still all surfaces unchanged), and a
pass on a machine **without** Document PiP support (or with the flag off) proving the button is absent and
nothing else changed.

## 6.4 Phase 6 — the spike AS RUN, the measurements, and why this is DEFERRED (2026-09-07)

**Outcome: DEFERRED. `src/**` was not touched; this section is the only change the phase made.**
Everything below was measured, not reasoned about. Re-read it before the next attempt.

### How the spike was driven (the harness this repo's browser tool cannot do)

The in-app preview browser **cannot open any second window at all**, so the spike could not be run
through it:

| Probe (in the preview browser, `http://localhost:51730`, top-level, not an iframe) | Result |
|---|---|
| `'documentPictureInPicture' in window` | `true`, `DocumentPictureInPicture` |
| `requestWindow()` with **no** user activation | `NotAllowedError: … requires user activation` (so the API is live and enforcing) |
| `requestWindow()` after a **real trusted click** on an injected button | **`InvalidStateError: Internal error: no window`** — reproduced twice |
| `window.open('', '_blank', 'popup,…')` after the same trusted click | **`null`** |
| an external Chrome to borrow (`list_connected_browsers`) | `[]` |

So the spike was run against a **real local Chrome** (`chrome.exe --remote-debugging-port`, headful, a
throwaway profile) driven over CDP from Node 22's built-in `WebSocket` — `Runtime.evaluate` with
`userGesture: true` supplies the activation token, and `Input.dispatchKeyEvent` /
`dispatchMouseEvent` on a session attached to the **PiP window's own target** supplies real trusted
input inside it. There, `requestWindow({width:900,height:640})` returns a live window
(Chrome clamps/remembers the size: it came back **1384×830**). The throwaway scripts are not in the
repo. **Anyone re-running this needs that setup; the preview browser is not enough.**

### The six protocol steps — per-surface results

Each run: load the model → Play → pop out (clone the opener's `<style>`/`<link>` set, `adoptNode` the
`.canvasArea` into the PiP body) → sample every 5 s → resize the PiP window → move back → close.
"hash" is a 160×160 downsample of the canvas (`drawImage` reads a *transferred* placeholder too, which
is what makes the worker-presented surfaces measurable at all).

| # | Surface / model | Result |
|---|---|---|
| 4 | **Plain 2D blit** — Game of Life (WebGPU grid) | **PASS.** Backing store followed the PiP box (964×769 → **1412×830**), gen **247 → 378 → 503 → 635** while out, a different hash at **every** sample, **0** console errors, **0** `attach*`. |
| 1 | **2D agents, GPU-resident direct render** — Particle Life | **PASS.** gen **91 → 290** while out, hash changing at every sample; **3 `attachAgentCanvas`** for the pop-out (a genuine display resize), **1** for the PiP resize; clean return, same worker, **0** errors. |
| — | **worker-presented `OffscreenCanvas` placeholder** — Particle Life **3D** (`agentSphereLayerRef`) | **PASS — the one §6.1 called "the hard one".** The transferred canvas resized to **1412×830** *inside the PiP document* and kept receiving presents: 4 distinct hashes over 20 s while gen ran **72 → 239**. Returned to 964×769 still presenting. **0** errors. |
| 3 | **WebGL2 `gl3d`** — Life3D, Particle Life 3D, Accretor | **PASS. No context loss:** `isContextLost() === false` at every sample, in the PiP document and after the return. It re-renders there too — a 3D view change driven from the opener repainted it (hash changed) in every 3D run. |
| 2 | **Voxel free mode** — Accretor (300³) | **PASS, with a caveat about the model, not the mechanism.** The run had already hit its own edge-stop (gen pinned at **155**, transport back to *Play*) before the pop-out, so per-step presents could not be sampled; the camera-change probe proved the transferred voxel canvas is live in the PiP document (hash `2830614240` → `3201863552`), and the pop-out itself cost **2 `attachVoxelCanvas`**. **Life3D's** apparently frozen voxel hash is likewise the MODEL: a control run that never leaves the main document holds the identical hash from gen 34 to gen 433. **Pick an unambiguously moving voxel model next time.** |
| 5 | **Close → return** | **PASS on every canvas** in all four models: back to the opener's box, still presenting, `window.__simWorker` the same object, **0** re-init. `pagehide` **does** fire on the PiP window, so §6.2's restore hook is available. |
| 6 | **Resize the PiP window** | **PASS, inside the ≤ 2 budget: 1 attach per gesture** (`attachAgentCanvas` on both Particle Life models, `attachVoxelCanvas` on Life3D), backing stores exactly matching the new box. |

**§6.1's risk table needs one correction.** In **2D** neither worker-presented canvas is in the DOM:
the WebGPU grid's direct-render canvas ([SimulatorView.tsx:8170](../src/simulator/SimulatorView.tsx),
`:8190`) and the 2D agent direct-render canvas (`:5958`) are **detached blit sources**, so document
adoption cannot reach them. The only DOM-resident transferred placeholders are the **3D** ones —
the agent sphere layer (`:5931`) and the voxel layer (`:6191`).

### ⛔ What actually blocks the phase: the PiP window is a SEPARATE EVENT TARGET TREE

Real trusted input dispatched **inside** the PiP window, with the simulation paused so nothing moves
on its own:

| Gesture (real, in the PiP window) | Observed |
|---|---|
| `Enter` (Live's one GLOBAL key — play/pause) | keydown on the **PiP** document ×1, on the **opener's** document **×0**. Transport stayed *Play*. **Dead.** |
| `Space` (step, viewport focus) | gen **0 → 0**. **Dead.** |
| left drag on the board (paint / brush / pan) | `mousedown` reaches the container (it travelled) ×2 — but `mousemove`/`mouseup` on the opener's `window` **×0**, and the canvas did not change. **Dead.** |
| middle drag | changed the view once and settled (not latched), but is not a working pan |
| **wheel zoom** | **WORKS** — and it is the only one, because that listener is on the container ELEMENT, which travels with the adopted DOM |

The cause is structural and it is the whole of `SimulatorView`'s input layer:
**36 listeners are registered on the OPENER's `window` / `document`** (grep
`window\.addEventListener\|document\.addEventListener` in that file), and a separate window does not
propagate to its opener. Eight of the 36 are app-internal `genesis-*` CustomEvents and are rightly
opener-scoped; the rest are real input, and every one of these is load-bearing for a popped-out viewport:

- `document keydown` ×5 — the **main transport / Live handler** (`:14102`), Phase 3's **`Ctrl+Enter` apply**
  (`:9584`), three overlay dismissers (`:2606`, `:2688`, `:3793`)
- `window keydown/keyup` ×6 — **`F`** (`:15623`), the agent shift-hover sync (`:11179-11180`), the 3D shift
  sync (`:10510-10511`), autoscroll (`:13371`)
- `window pointermove/pointerup` (`:10513-10514`) — **the 3D ORBIT's release**: `pointerdown` is on the GL
  canvas (travels), the release is not (does not)
- `window mousemove/mouseup` (`:13369-13370`) — **the 2D pan / brush drag**
- `window blur` (`:11181`) — the shift-latch guard
- `document mousemove/mouseup` ×3 (`:15695`, `:17284`, `:18034`) — the panel splitters
- `window resize` ×2 (`:9590`, `:15549`) — the opener's resize, not the PiP window's

And two shared predicates answer for the **wrong document**: `overlayOwnsKeyboard()`
([liveKeyboard.ts](../src/live/liveKeyboard.ts)) queries `document` for `[role="dialog"], [role="menu"]`,
and every typing-target check reads `document.activeElement` — with focus in the PiP window the opener's
`activeElement` is stale, so the modal / menu stand-down and the "is the user typing" test both lie.

**Verdict.** Making the pop-out honest means a **document-parameterised input layer** — every one of those
36 registrations bound to the right event root, both predicates taking a document, `window.devicePixelRatio`
read per-window (4 sites: `:5640`, `:5923`, `:6181`, `:6345` — a PiP window can sit on a monitor with a
different DPR), plus the `liveFocus` source for the PiP pane the Phase-4 handoff already flagged. Each of
those listeners carries a Phase-4 documented contract that would then have to be re-verified across the
keyboard × pointer × 2D/3D matrix. That is a phase of its own, not the "button + adopt + `pagehide` +
`simLayoutApi` + copy the custom properties" of §6.2 — and shipping without it would put a viewport on the
user's second monitor that they cannot pan, paint, orbit, step or pause, which is exactly the
*"an enabled control must do something"* failure the doctrine forbids, at the scale of a whole pane.

### Three more corrections §6.2 needs before it is re-attempted

1. **"Copy every CSS custom property" is not enough.** The PiP document inherits **no stylesheet at all**,
   and this app is CSS Modules: **33 `<style>` nodes** in the dev server (one per module), a single `<link>`
   in a production build. Clone the whole set, **and** the `<html>` / `<body>` class names — the theme lives
   there. (The spike did exactly this and the viewport bar rendered correctly.)
2. **`ResizeObserver loop completed with undelivered notifications`** appears while the observed
   `.canvasArea` lives in the PiP document, and **floods** (8+ in 2 s) once that document is torn down with
   the element still inside it. So the restore must move the element back **before** the PiP document goes
   away — `pagehide` fires, but the RO also needs re-targeting. "0 console errors" is not free here.
3. **The pop-out itself is a display resize** and costs **2–3 `attach*Canvas`**, above the splitter's ≤ 2.
   Fine, but measure it rather than assume the splitter's number carries over.

### What is NOT in doubt any more

Do not re-litigate the canvases. Cross-document adoption of a 2D display canvas, the `mix-blend-mode`
cursor overlays, a live WebGL2 context and a worker-presented `OffscreenCanvas` placeholder is
**measured-good in a real Document PiP window, in and back, with the same worker and no re-init.** The
next attempt starts at the input layer.

---

## Appendix A — the anchor index

Everything the phases hook into, in one place. Line numbers are from commit `092a8c7`; re-grep the symbol
if they have drifted.

| Anchor | What |
|---|---|
| `src/App.tsx:23` | `AppMode` union |
| `src/App.tsx:34-49` | `modeIcon()` + the two existing mode icons |
| `src/App.tsx:169-180` | the `?` cheat-sheet listener |
| `src/App.tsx:226-283` | drag-and-drop routing (the `setMode` calls needing a Live guard) |
| `src/App.tsx:436-444` | `<main>` — the I1-critical mounting block |
| `src/App.module.css:237-240` | `.content` |
| `src/modeler/ModelerView.tsx:150, 223-234` | `prePanelStateRef` + `toggleCanvasFullscreen` |
| `src/modeler/ModelerView.tsx:262-300` | the capture-phase keyboard handler (`Ctrl+F`, `F`, `Space`, `Esc`) |
| `src/modeler/modelerUiState.ts:14-36` | the modeler layout snapshot |
| `src/modeler/vpl/graphState.ts:16-35, 57-72` | saved viewports/scope; the `activeGraphKind` pub/sub template |
| `src/modeler/vpl/GraphEditor.tsx:1091-1127` | `scheduleSync` / `flushSync` |
| `src/modeler/vpl/GraphEditor.tsx:1955-1956` | `isDrag` / `isDragEnd` |
| `src/modeler/vpl/GraphEditor.tsx:2061-2067` | `needsSync` |
| `src/modeler/vpl/GraphEditor.tsx:3875-3892` | the graph clipboard + undo/redo keyboard handler |
| `src/simulator/SimulatorView.tsx:1213` | `LAYOUT_RESIZE_SETTLE_MS` |
| `src/simulator/SimulatorView.tsx:1843-1857` | `safeCompileGraph` |
| `src/simulator/SimulatorView.tsx:2276` | the component signature (`visible`) |
| `src/simulator/SimulatorView.tsx:2299` | `compileError` |
| `src/simulator/SimulatorView.tsx:2599-2609` | `layoutResizeUntilRef` / `resizeAttachDeferred` |
| `src/simulator/SimulatorView.tsx:2979-2983` | `recordCropRef` / `recordDimsRef` |
| `src/simulator/SimulatorView.tsx:3197-3221` | the `genesisca_sim_settings` persist effect (declaration-order trap) |
| `src/simulator/SimulatorView.tsx:3505-3624` | the Overseer block (`overseerEnabled`, `abortExperiment`, `handleRunExperiment`) |
| `src/simulator/SimulatorView.tsx:4802-4820` | `compileModel` + the init-path `setCompileError` arms |
| `src/simulator/SimulatorView.tsx:6155, 6194, 6911, 7019` | the four `OffscreenCanvas` re-attach sites |
| `src/simulator/SimulatorView.tsx:7317, 7365, 7790` | `targetFpsRef` and the pacing |
| `src/simulator/SimulatorView.tsx:7629` | **the per-`stepped` `draw()`** — the skip-blit seam |
| `src/simulator/SimulatorView.tsx:8937-9226` | the model effect: `prevModelRef`, `needsFullInit`, reinit, soft recompile, `recompile` post |
| `src/simulator/SimulatorView.tsx:9355-9391` | `scheduleLayoutDraw` + the `ResizeObserver` catch-all |
| `src/simulator/SimulatorView.tsx:10693-10721` | **the visible-effect** — auto-pause + the three re-present blocks |
| `src/simulator/SimulatorView.tsx:13083-13106` | the play kick-start effect |
| `src/simulator/SimulatorView.tsx:13108-13159` | `handleStep` / `handleReset` (+ the Overseer gates) |
| `src/simulator/SimulatorView.tsx:13503-13741` | **the main keyboard handler** — ungated today |
| `src/simulator/SimulatorView.tsx:14985-14996` | the four panel/bar states |
| `src/simulator/SimulatorView.tsx:15005-15013` | the layout `useLayoutEffect` (trigger 1) |
| `src/simulator/SimulatorView.tsx:15080-15117` | `prePanelStateRef`, `toggleCanvasFullscreen`, the `F` key, the fullscreen event |
| `src/simulator/SimulatorView.tsx:15168-15183` | the left-panel splitter (trigger 2) |
| `src/simulator/SimulatorView.tsx:15500-15527` | the two `compileError` render sites |
| `src/simulator/SimulatorView.tsx:15537-15568` | the 2D/3D canvas layer stack |
| `src/simulator/ExperimentsPanel.tsx:417, 426` | Run / Abort gating |
| `src/simulator/engine/sim.worker.ts:5889-5934` | `compileFns` — where a bad compile nulls the rule |
| `src/simulator/engine/sim.worker.ts:8117-8250` | `case 'recompile'` |
| `src/simulator/engine/sim.worker.ts:8402, 8503, 8575, 8675, 8765` | the present-only refresh/camera messages |
| `src/components/KeyboardShortcutsOverlay.tsx:18-71` | `GROUPS` |

## Appendix B — what this feature explicitly does NOT do

- No overlay / glass / dim slider / Alt reach-through (Option A, dropped).
- No in-page floating viewport window (Option C's non-PiP half, dropped).
- No compiler, node, schema, worker-protocol or file-format change.
- No change to the standalone `.html` export (it ships `SimulatorView` only).
- No change to how the Modeler or the Simulator behave **outside** Live, except the two keyboard bug
  fixes in Phase 4 — which are corrections, not regressions.

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
| **6** | **Stretch** — Document Picture-in-Picture pop-out, behind a feasibility spike | Ships or is documented as deferred |

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

---

# Phase 6 — Stretch: pop the Live viewport out to an OS window (Document PiP)

**Feasibility-gated. This phase may end in a written deferral, and that is an acceptable outcome.**

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

# Impact Map — **Live** mode (split workspace: rule graph + running simulation side by side)

> **Status: planning document. No code.** Design authority for the implementation plan
> [PLAN_LIVE_SPLIT.md](PLAN_LIVE_SPLIT.md) / [PLAN_LIVE_SPLIT.html](PLAN_LIVE_SPLIT.html).
> Origin: [BRAINSTORM_SEE_THROUGH_CANVAS.md](BRAINSTORM_SEE_THROUGH_CANVAS.md) + `.html`
> (three layouts explored; **Option B — Split workspace** is the one being built).
>
> Written per the *Impact Map First* rule (≥3 subsystems / runtime mounting change) and after the
> *Read to CLOSURE* walk over `docs/areas/simulator-ui.md` · `modeler-ui.md` · `simulation-engine.md` ·
> `agent-render.md` · `overseer.md` · `grid-3d.md` · `indicators.md` · `project-structure.md`.
> **Every claim below is anchored to `file:line` in the tree at branch `tasks_batch_02-09` (commit `092a8c7`).**
> Line numbers drift; the anchors name the *symbol* too, so re-grep if they have moved.

---

## 0. What is being built, and what is out

**Live is a third top-level mode** (`Modeler · Simulator · Live`) that shows the **rule graph and the
running simulation at once**, in a split workspace: two opaque panes divided by a draggable splitter,
each fully interactive, no transparency and no pointer arbitration.

| Locked in | Locked out |
|---|---|
| Option **B** — split workspace only | Option **A** — backdrop overlay / glass / Alt reach-through, **dropped entirely** (not even a layout setting) |
| Live as a **third top-level mode** | A toggle inside the Modeler |
| Draggable splitter · layout menu (dock right / dock bottom / swap sides / collapse viewport) · double-click = 50 % · position persists | Option **C**'s in-page floating window |
| Last-good-rule · apply policy (Auto ~100 ms / On-demand + `Ctrl+Enter`) · structural-rebuild prompt · dual mounting ("shown" ≠ "active tab") · keyboard ownership · perf guards (FPS cap 30, skip-blit during node drag, debounce stretch) · Overseer ↔ Live mutual exclusion | Alt reach-through (Overlay-only mechanic) |
| **Phase 6 stretch**: pop the Live viewport out to an OS window via Document Picture-in-Picture, **behind a feasibility spike** | Anything touching the compilers or emitted output |

**ZERO compiler / emit impact.** Live changes *layout, mounting, and input ownership*. Nothing in
`src/modeler/vpl/compiler/**`, no node definition, no worker step path, no schema field. This is a
falsifiable claim and §14 says how it is proved.

---

## 1. Verdict table

| # | Subsystem | Impact | Risk | Files |
|---|---|---|---|---|
| S1 | App shell — mode enum, `<main>` mounting, nav | **Medium** — new mode, new layout container, ModelerView wrapper | ⚠⚠ *remount hazard* | `src/App.tsx`, `src/App.module.css` |
| S2 | SimulatorView `visible` semantics | **High** — one prop splits into *shown* vs *active tab* | ⚠⚠⚠ | `src/simulator/SimulatorView.tsx` |
| S3 | ModelerView / GraphEditor containers | **Low–Medium** — pane sizing; React Flow self-resizes | ⚠ | `src/modeler/ModelerView.tsx`, `.module.css` |
| S4 | Compile pipeline + error banner (last-good-rule) | **High** — the model effect gains two intercepts | ⚠⚠⚠ | `SimulatorView.tsx` (model effect) |
| S5 | Keyboard ownership | **High** — 15 global listeners, two already conflict today | ⚠⚠⚠ | `SimulatorView.tsx`, `ModelerView.tsx`, `GraphEditor.tsx`, `App.tsx` |
| S6 | Overseer mutual exclusion | **Medium** — both directions | ⚠⚠ | `SimulatorView.tsx`, `ExperimentsPanel.tsx` |
| S7 | Two side-panel systems + Live panel policy | **Medium** — state leakage between modes | ⚠⚠ | both views |
| S8 | Splitter + persistence | **Medium** — must reuse the resize/re-attach machinery | ⚠⚠ | new `liveUiState.ts`, `SimulatorView.tsx` |
| S9 | Perf guards | **Low–Medium** | ⚠ | `SimulatorView.tsx`, `GraphEditor.tsx` |
| S10 | 2D vs 3D | **Medium** — layered canvas stack, orbit input, gl3d resize | ⚠⚠ | `SimulatorView.tsx`, `render/gl3d.ts` |
| S11 | Worker message surface | **None (no new messages)** — but four existing ones must fire on a new trigger | ⚠⚠ | `sim.worker.ts` (read-only) |
| S12 | Capture / recording | **Low** — one new interlock | ⚠ | `SimulatorView.tsx` |
| S13 | Persistence / `.gcaproj` | **None to the file format**; new localStorage key | ✓ | new module |
| S14 | Compilers / emitted output | **ZERO** | ✓ (must be *proved*) | — |

---

## 2. S1 — App shell: mode enum, `<main>` mounting, the nav

### What is there now

```
src/App.tsx:23    type AppMode = 'modeler' | 'simulator' | 'help' | 'library' | 'styleref';
src/App.tsx:54    const [mode, setMode] = useState<AppMode>('library');   // every load lands on the Library
src/App.tsx:380-389  navCenter — the two mode buttons (MODELER_ICON / SIMULATOR_ICON, defined at :43-49)
src/App.tsx:436-444  <main className={styles.content}>
src/App.tsx:437       {mode === 'modeler' && <ModelerView />}
src/App.tsx:438-440   <div style={{ display: mode === 'simulator' ? 'contents' : 'none' }}>
                        <SimulatorView visible={mode === 'simulator'} />
                      </div>
src/App.module.css:237-240  .content { flex: 1; overflow: hidden; }   /* a plain block, not a flex container */
```

Both view roots are `display: flex; height: 100%` (`ModelerView.module.css:1-4`,
`SimulatorView.module.css:1-4`), and the `display: contents` wrapper makes `.simulatorLayout` a direct
child of `.content`, so each fills the content box on its own.

### ⚠⚠ THE REMOUNT HAZARD — the single most dangerous thing in this feature

`SimulatorView` **owns the Web Worker, the WASM memory, the WebGPU device, the agent SoA snapshot and the
grid state**. A React remount destroys all of it and the running simulation is gone.

React reconciles by **position in the element tree**. If Live renders `<SimulatorView>` inside a *new*
wrapper element — a pane `<div>` that does not exist in Simulator mode — React sees a different element
at that slot and **unmounts + remounts** it. The user would switch to Live and watch generation 12 000
reset to 0.

**The rule this feature is built on: the React element tree must be IDENTICAL in `simulator` and `live`
mode; only `className` / `style` on the wrappers may differ.** Concretely:

```jsx
<main className={`${styles.content} ${mode === 'live' ? styles[`live_${liveLayout}`] : ''}`}>
  <div className={paneClassFor('modeler')}>          {/* NEW — always mounted, empty in Simulator */}
    {(mode === 'modeler' || mode === 'live') && <ModelerView />}
  </div>
  {mode === 'live' && <LiveSplitter … />}            {/* the splitter is a Live-only sibling */}
  <div className={paneClassFor('simulator')}>        {/* the EXISTING wrapper, reclassed */}
    <SimulatorView visible={…} shown={…} />
  </div>
  …
</main>
```

- The **simulator wrapper already exists** (`App.tsx:438`), so reclassing it from `display:contents` to a
  real flex item changes no React position — a DOM `display` change never remounts children.
- The **ModelerView wrapper is new and must be added unconditionally in every mode** (with
  `display: contents` outside Live, so today's Modeler layout is byte-identical). Introducing it only in
  Live would remount `ModelerView` on every Modeler↔Live switch. `ModelerView` remounting is *survivable*
  (`modelerUiState` + `graphState` restore panels, scope and viewport — `modelerUiState.ts:5-13`,
  `graphState.ts:3-27`) but it rebuilds React Flow and re-fits nodes; there is no reason to pay it.
- Inserting the splitter **between** the two panes is safe: it is a Live-only element appearing *after*
  the modeler wrapper and *before* the simulator wrapper, and React keys siblings positionally per slot,
  so `{cond && <X/>}` renders `null` in the other modes and holds the slot.
- **Dock bottom / swap sides are pure CSS** on `.content` (`flex-direction: row | column | row-reverse |
  column-reverse`). No element moves. This is why the "layout menu" costs almost nothing.

### Also in S1

- `AppMode` gains `'live'`; the nav gains a third `navModeButton` with its own icon (`App.tsx:34-49`
  `modeIcon()` is the shared factory — the Live glyph must use it or it will not theme).
- **Live must be greyed while an Overseer experiment runs** — see S6.
- `App.tsx:182-185 afterLoad()` sends every load to `'simulator'`. Live is **not** a landing mode; leave
  it. (A model load in Live keeps the user in Live — `loadModel` does not touch `mode`.)
- Drag-and-drop routing (`App.tsx:226-283`) hard-codes `setMode('simulator')` for `.csv` / images /
  GeoTIFF / GeoJSON. **In Live those dialogs live in the already-shown SimulatorView, so the
  `setMode('simulator')` calls must become `if (mode !== 'live') setMode('simulator')`** — otherwise
  dropping a CSV while in Live kicks the user out of Live. `.gcamacro` (`:245-252`) does the mirror image
  with `setMode('modeler')` and needs the same guard.
- The `?` cheat-sheet listener (`App.tsx:169-180`) is mode-agnostic and needs no change, but its content
  does (S5, Phase 5).

---

## 3. S2 — `SimulatorView`'s `visible` prop splits into **shown** vs **active tab**

`SimulatorView({ visible = true, hideInstructionsPill = false })` — `SimulatorView.tsx:2276`.
`visible` today conflates **three** different questions. Live needs them separated.

### Everything `visible` currently gates

| Site | What it does | Live needs |
|---|---|---|
| `:10693-10721` the visible-effect | `visible` → `requestAnimationFrame(draw)` **and** re-present: `refreshDisplay` (`:10704`), `setGridCamera` + `refreshGridDisplay` (`:10707-10711`), `setAgentCamera` + `refreshAgentDisplay` (`:10713-10717`). `!visible && playing` → **`setPlaying(false)`** (`:10718-10720`) — the auto-pause. | **shown** — and the auto-pause must NOT fire when Live is shown |
| `:15081-15082` `visibleRef` | the ref every non-React consumer reads | **shown** |
| `:7296-7297`, `:7308` | `if (visibleRef.current) drawRef.current()` — sprite-registry `onReady` redraw. **Guards the documented 0×0 `drawImage` → `InvalidStateError` → React unmount crash** (`simulator-ui.md`: *"Every draw call added outside the step loop must be `visibleRef.current`-gated"*) | **shown** |
| `:10481`, `:10563` | the 3D auto-orbit/zoom and Follow rAF loops: `if (!visibleRef.current) { last = 0; … }` — resets `dt` so a tab-away cannot fling the camera | **shown** |
| `:14882` | the `paste` (Ctrl+V image) window listener gate | **shown** |
| `:15101` | the `F` fullscreen key gate | **shown** *(and see S5 — F must reach BOTH views in Live)* |
| `:15005-15013` | the layout `useLayoutEffect`, dep list starts with `visible` | **shown** |
| `:15069` | the capture-collision measure effect | **shown** |
| `:9358-9380` `scheduleLayoutDraw` | *not* `visible`-gated — it early-returns on `clientWidth < 2`, which is how a hidden (0×0) view is detected today | unchanged — the pane always has a real width in Live |

### The split

- **`shown`** = "this view's canvas has a real, non-zero box on screen". `true` in `simulator` **and**
  `live`. It is what `visibleRef` becomes.
- **`activeTab`** = "this view is the whole content area, and owns the keyboard by default". `true` only
  in `simulator`.

**Only two behaviours key off `activeTab`:** the auto-pause (`:10718-10720`) and the default keyboard
owner (S5). Everything else follows `shown`. The cleanest shape — and the one that keeps the diff small —
is to keep the prop name `visible` meaning **shown**, and add a second prop `activeTab`:

```ts
<SimulatorView visible={mode === 'simulator' || mode === 'live'} activeTab={mode === 'simulator'} />
```

⚠ **Trap — the auto-pause arm must become `else if (!activeTab && !liveShown && playing)`, and its effect
deps must gain the new flag.** The effect at `:10721` deps on `[visible, draw, playing, computeAgentRenderView, computeVoxelRenderView]`;
`playing` is in there deliberately (it is what makes the pause self-correcting — see S5's Enter finding).
Forget the dep and leaving Live to `help`/`library` will not pause the run.

⚠ **Trap — the re-present block (`:10703-10717`) is keyed on `visible` becoming true.** Entering Live is
exactly the same transition (hidden 0×0 → real box) that the block exists for, so it fires correctly —
**but it also fires when leaving Live for `help`/`library` and coming back**, and on every
`playing` change (because `playing` is a dep), which posts three redundant worker messages per
play/pause. That is pre-existing and harmless (each is present-only), but if the deps grow, keep
`playing` out of any new re-present logic.

⚠ **Trap — `hideInstructionsPill`** (`:2276`) is the standalone-viewer's prop. Live must not reuse it; the
instructions pill sits at `left: 36px` (`simulator-ui.md` — "clear of the panel-expand ear") and in a
narrow Live pane it collides with the viewport bar. Disposition: keep the pill, move the Live viewport
bar to the *top-right* of the pane.

---

## 4. S3 — ModelerView / GraphEditor containers, remount, `modelerUiState`

- `ModelerView.tsx:312-372` — `<ReactFlowProvider>` → `.modelerLayout` (flex row): ActivityBar · primary
  PanelShell · detail PanelShell · `.graphArea` (`flex: 1; position: relative; overflow: hidden`) ·
  right PanelShell · RightActivityBar.
- **React Flow resizes itself.** `simulator-ui.md` records it explicitly: *"The Modeler's React Flow
  canvas is untouched and resizes itself (1000 → 1320 on a panel collapse)."* So the Live splitter needs
  **no** modeler-side plumbing — unlike the simulator (S8).
- `modelerUiState.ts:14-36` holds `activePanel · activeRightPanel · lastLeftPanel · lastRightPanel ·
  selectedByPanel · activeGraph · propertiesTab`. `graphState.ts:16-35` holds the per-scope viewport and
  the saved scope stack. Together they mean **a ModelerView remount is cheap and lossless** — which is
  the safety net if S1's wrapper trick is ever violated.
- **Panel widths do NOT persist.** `PanelShell.tsx:36-65` mutates `panel.style.width` / `minWidth`
  directly on drag and the element is unmounted on close; the simulator's own handle does the same
  (`SimulatorView.tsx:15168-15183`) with the comment *"the panel is unmounted next render, so any inline
  width/minWidth set during the drag goes with it — re-opening starts from the CSS default"*.
  **⇒ the brainstorm's "the splitter position persists like the panel widths" is factually wrong**
  (§16). The splitter needs its own persistence; see S8.
- **In Live the graph pane is roughly half width.** Two existing modeler affordances get more load-
  bearing: the minimap and `F` (collapse both side panels — `ModelerView.tsx:223-234`). Nothing breaks;
  the plan simply defaults the Live modeler pane to *panels collapsed* on first entry (a stored
  preference thereafter), which is the `prePanelStateRef` pattern already in `ModelerView.tsx:150`.
- **Macro scope survives.** `graphState.ts:31-35 savedCurrentScope` — editing inside a macro while the sim
  runs is the same pipeline (`scheduleSync` routes macro scopes to `updateMacro`, `GraphEditor.tsx:1096`).
  The breadcrumb costs vertical space; in a *split* (unlike an overlay) that is simply the graph pane's
  own budget, so the brainstorm's open question here dissolves.

---

## 5. S4 — the compile pipeline and the error banner (**last-good-rule**)

This is where most of the real work is. Trace, end to end:

```
GraphEditor.tsx:2061-2067   needsSync → scheduleSync()
GraphEditor.tsx:1091-1108   scheduleSync — 100 ms debounce → setGraph / setAgentGraph / setOverseerGraph
                            (macro scope → updateMacro)
ModelContext (reducer)      SET_GRAPH … (092a8c7: a deep-equal write-back now returns the SAME state ref)
SimulatorView.tsx:8937-9040 useEffect([model, compileModel]) — `prev = prevModelRef.current;
                                                               prevModelRef.current = model;`
                            :8944  if (prev && overseerRunningRef.current) abortExperiment('model changed')
                            :8946-9040  needsFullInit = … (25 structural comparisons)
                            :9041-9068  FULL REINIT — worker.terminate(); initWorkerWithDimensions(…)
                            :9069-9226  SOFT RECOMPILE — safeCompileGraph (:9096) + compileAgentModel,
                                        setCompileError (:9111/:9113/:9116/:9120),
                                        postMessage({type:'recompile', …}) (:9156)
sim.worker.ts:8117-8250     case 'recompile' → compileFns(msg.stepCode, …) (:8124)
sim.worker.ts:5889-5934     compileFns — `stepFn = stepCode ? eval(stepCode) : null` … catch → null
SimulatorView.tsx:15500-15504  compileError → the left settings panel's red block
SimulatorView.tsx:15523-15527  compileError → `.errorBanner` over the canvas
```

### ⚠⚠⚠ Trap A — a failed compile **nulls the running rule in the worker**

`sim.worker.ts:5899` — `stepFn = stepCode ? (eval(stepCode) as Function) : null`. `safeCompileGraph`
(`SimulatorView.tsx:1843-1857`) returns `stepCode: ''` on a throw, and `compileGraph` returns an empty
step on a hard graph error. So today a half-wired graph does not merely *show* an error: it **replaces the
running rule with nothing**. That is fine for the Simulator tab (the user asked to recompile); it is fatal
for Live, where a graph is half-wired dozens of times a minute.

**The seam is on the MAIN THREAD, and that is deliberate: it keeps `sim.worker.ts` untouched.** When Live
is shown *and* the JS reference compile reports an error, **do not post the `recompile` message at all** —
the worker keeps its last good `stepFn` / `wasmStepFn` / WebGPU pipeline by construction, because a
message it never receives cannot change them. Set the chip to `● stale` and keep the amber `!` badges the
Modeler already renders (`nodeValidation.ts` → CaNode header badge, `modeler-ui.md` "Node config
validation").

### ⚠⚠⚠ Trap B — `setCompileError` is **not** a compile-error channel

It is the simulator's general error surface: 18 call sites, of which only **6** are graph compiles
(`:4814 :4816 :4819` init path, `:9111 :9113 :9116` soft path, plus the agent append `:8399 / :9120`).
The rest are **CSV import failed** (`:14550`), **GeoTIFF** (`:14693`), **GeoJSON** (`:14729`),
**preset import** (`:14126 / :14951`), **CSV export** (`:14862`), a worker-pushed `error` message
(`:7898`), and dimension/apply failures (`:13994 / :14361 / :14930`).

**⇒ "suppress the red banner in Live" must be scoped to the graph-compile arms only.** A blanket
suppression would silently swallow a failed GIS import — the user drops a GeoTIFF, nothing happens, no
message. Concretely: keep `setCompileError` for everything else, and route the graph-compile result
through a new `setRuleCompileState({ status: 'ok' | 'stale', message })` that the chip reads and the
banner ignores while Live is shown.

### ⚠⚠⚠ Trap C — the structural-rebuild prompt must NOT advance `prevModelRef`

`SimulatorView.tsx:8938-8939`:

```ts
const prev = prevModelRef.current;
prevModelRef.current = model;          // ← advanced unconditionally, at the TOP of the effect
```

`needsFullInit` (`:8946-9040`) is computed as `prev` vs `model`. If Live *defers* a structural change
(the "Rebuild needed · the board will re-seed · Apply / Later" prompt), and `prevModelRef` has already
been advanced, then the **next** edit compares the new model against the *already-changed* baseline,
`needsFullInit` comes back `false`, and the deferred rebuild is silently lost — the worker runs the old
layout while the model claims the new one. That is exactly the baked-offset desync class the 25
comparisons exist to prevent.

**⇒ deferral must keep an `appliedModelRef` (the last model actually pushed to the worker) and compute
`needsFullInit` against THAT**, advancing it only when a reinit or recompile really happens. "N structural
edits cost one reset" falls out for free, because every deferred edit keeps comparing against the same
applied baseline.

`resetRestoresBoard` (`types.ts`; read at `SimulatorView.tsx:13129`, `savedBoard` at `:13128`) already
answers *what comes back* after the reset, and the prompt copy should say which of the two it will be —
`resetDefaultMode` at `:13130` is the single resolver.

### Trap D — the apply policy's two modes

- **Auto (~100 ms)** = today's behaviour: `scheduleSync`'s existing 100 ms timer (`GraphEditor.tsx:1092`).
- **On demand** = the chip shows `● pending`; `Ctrl+Enter` applies. The cheapest implementation is *not*
  to change `scheduleSync` (which also feeds undo/redo, the macro write-back and the dirty flag) but to
  hold the **model→worker** step: in the model effect, when Live is shown and the policy is on-demand,
  skip the recompile/reinit and mark pending; `Ctrl+Enter` re-runs it. The graph still syncs to the model
  at 100 ms, so undo, save and the Modeler's own views stay live.
- ⚠ **`Ctrl+Enter` must not collide** with anything: no handler in the tree binds it today (grep of the
  15 listeners in S5 confirms). It must be registered *capture-phase on `document`* like
  `ModelerView.tsx:298`, so it works with focus in the graph.

### Trap E — the agent half has its own error arm

`:8399` and `:9120` append `[agents] …` to `compileError` with a functional `setCompileError(prev => …)`.
The last-good-rule intercept has to cover **both** halves or an agent-graph edit still nulls
`agentBehaviourFn` (`sim.worker.ts:5941-5944`) while the cell rule keeps running — a half-frozen model,
which reads as a bug rather than as "stale".

---

## 6. S5 — keyboard: the complete global-listener inventory

**Fifteen global keyboard listeners are live at once in this app.** `SimulatorView` is *always mounted*
(`App.tsx:438`), so its listeners are registered even in the Modeler. This is the area with the most
pre-existing breakage.

| # | File:line | Phase / target | Keys | Gated by | Live disposition |
|---|---|---|---|---|---|
| 1 | `App.tsx:178` | bubble / window | `?` | field check | unchanged (global) |
| 2 | `ModelerView.tsx:298` | **capture** / document | `Ctrl+F`, `F`, `Space`, `Esc` | field check; `Space` calls `stopImmediatePropagation()` (`:286`) | **owns the graph pane**; `F` must be re-routed (below) |
| 3 | `GraphEditor.tsx:962-963` | capture / window | tracks Ctrl held (align guides) | — | unchanged |
| 4 | `GraphEditor.tsx:1520` | capture / document | `Esc` — cancels an armed explicit-control pick; `stopPropagation()` | only when a pick is armed | unchanged |
| 5 | `GraphEditor.tsx:3890` | **bubble** / document | `Ctrl+Z/Y/C/V/X/D` | field check only | ⚠⚠⚠ **conflicts** — see below |
| 6 | `GraphEditor.tsx:5153` | window (scope drag) | `Esc` | only during a scope drag | unchanged |
| 7 | `ColorField.tsx:100` | capture / document | `Esc` | popover open | unchanged |
| 8 | `SimulatorView.tsx:2545` | capture / document | `Esc` (overlay popover dismiss) | popover open | unchanged |
| 9 | `SimulatorView.tsx:2627` | capture / document | `Esc` (a second popover family) | popover open | unchanged |
| 10 | `SimulatorView.tsx:3714` | capture / document | `Esc` (capture-review modal) | modal open | unchanged |
| 11 | `SimulatorView.tsx:10206-10207` | window | Shift track (3D voxel pre-warm) | pointer over the GL canvas | unchanged |
| 12 | `SimulatorView.tsx:10868-10870` | window + `blur` | Shift track (agent UI-sync want-term) | — | unchanged |
| 13 | `SimulatorView.tsx:13060` | window | `Esc` — exits autoscroll | only while autoscrolling | unchanged |
| 14 | **`SimulatorView.tsx:13739`** | **bubble / document** | **`Space` · `Enter` · `Esc` · `Backspace` · `Ctrl+C/V/X` · 3D numpad 1-9** | field check + capture-review only — **NO `visible` gate** | ⚠⚠⚠ **the core of Phase 4** |
| 15 | `SimulatorView.tsx:15111` | window | `F` | **`visibleRef`-gated** (`:15100`) | must fire in Live |

### ⚠⚠⚠ Finding 1 — listener #14 is not visibility-gated, and it misbehaves in the Modeler **today**

`SimulatorView.tsx:13503-13509` opens with only a field check and a capture-review check. There is no
`visibleRef.current` guard anywhere in the handler (verified: the `visibleRef` uses in the file are at
`:7296 :7308 :10481 :10563 :14882 :15101` — none inside `13503-13741`). Consequences, **in the Modeler,
right now**:

- **`Esc` → `handleReset()`** (`:13737` → `:13132`). `handleReset` has no visibility guard either (only
  the Overseer one at `:13133`). **A stray `Esc` in the Modeler resets the running simulation.** Nothing
  intercepts it: `ModelerView.tsx:292-296` only acts when a right panel is open and never calls
  `stopPropagation`; GraphEditor's `Esc` handlers (#4, #6, and the drop-menu one at `:5284`) fire only in
  their armed states.
- **`Enter` → `setPlaying(p => !p)`** (`:13728`). The `[playing]` effect at `:13083` kicks
  `sendNextStep()`, and effects run in declaration order, so the visible-effect's auto-pause
  (`:10718`, declared earlier) queues `setPlaying(false)` for the *next* render while `:13083` has already
  posted one `step` batch. **`Enter` in the Modeler advances the simulation by one batch.**
- **`Ctrl+C/V/X` reaches the region/agent clipboard.** In 2D it usually no-ops because
  `handleMouseLeave` (`:13035-13044`) nulls `cursorGrid.current` when the pointer leaves the canvas — but
  in **3D** the handler `preventDefault()`s and calls `showAgentNotice(…)` *before* any guard
  (`:13521-13526`), so `Ctrl+C` in the Modeler on a 3D model fires a (invisible) simulator toast and a
  React state update.
- **`Space`** is the only one that is safe, and only because `ModelerView.tsx:286` calls
  `stopImmediatePropagation()` on it.

**⇒ Live does not create this bug, it makes it unmissable.** Fixing it (adding an explicit ownership gate
to #14) is Phase 4's first task and is a genuine bug fix independent of Live.

### ⚠⚠⚠ Finding 2 — `Ctrl+C / V / X` is bound **twice**, in the same phase, on the same target

`GraphEditor.tsx:3890` (bubble, document) and `SimulatorView.tsx:13739` (bubble, document) both bind
`Ctrl+C/V/X`. In Live both surfaces are on screen, both handlers run, and a `Ctrl+V` meant for the node
graph would *also* paste a cell region / agent cluster into the grid. Neither calls `stopPropagation`.

### The Live keyboard-ownership model (Phase 4)

**A single module-level focus owner**, `liveState.ts` → `getLiveFocus(): 'graph' | 'viewport'`, set by the
last pointer-down / pointer-enter inside each pane and rendered as a 1 px accent ring on the focused pane
(the brainstorm's focus ring). It is the `activeGraphKind` pub/sub pattern exactly
(`graphState.ts:57-72`) — private `let`, getter, `subscribe` returning an unsubscribe, equality-guarded
setter that notifies — so memoised consumers re-render.

| Key | Modeler today | Simulator today | **Live** |
|---|---|---|---|
| `Space` | quick-add menu at cursor (#2, capture, `stopImmediatePropagation`) | step (#14) | **focused surface**. #2 already wins by capture phase; it must additionally *not* claim `Space` when focus is `viewport`, letting #14 run. |
| `Enter` | — | play / pause (#14) | **global play/pause**, unless a field / menu / dialog has focus. The one deliberate exception — it is the reason Live exists. |
| `Ctrl+Enter` | — | — | **apply now** (on-demand policy). New, capture-phase. |
| `Esc` | closes a menu / right panel (#2) | **reset** (#14) | **never resets.** Esc closes a menu if one is open, else nothing. Reset stays a button. |
| `Backspace` | — | reset (#14, same arm) | same as `Esc` — **must be included**; it is easy to fix `Esc` and leave `Backspace` resetting the board. |
| `Ctrl+Z / Shift+Z / Y` | graph undo (#5) | — | graph undo (the run is not undoable) |
| `Ctrl+C / V / X` | graph clipboard (#5) | cell/agent clipboard (#14) | **focused surface only** — the double-binding above must be resolved |
| `Ctrl+D` | duplicate nodes (#5) | — | unchanged |
| `Ctrl+F` | node search (#2) | — | unchanged |
| `F` | collapse modeler panels (#2 → `toggleCanvasFullscreen`, `ModelerView.tsx:223`) | collapse simulator panels/bars (#15 → `toggleCanvasFullscreen`, `SimulatorView.tsx:15083`) | **collapses BOTH** |
| digits `1-9` | — | 3D view angles (#14, `:13706-13726`) | viewport-focused only |
| `?` | cheat sheet (#1) | cheat sheet (#1) | unchanged |

**`F` is nearly free.** Both views already listen for the window event
`genesis-toggle-canvas-fullscreen` (`ModelerView.tsx:236-240`, `SimulatorView.tsx:15114-15117`) and
`SimulatorView`'s consumer is `visibleRef`-gated — which is `shown`, i.e. true in Live. So in Live, one
key press must dispatch the event **once** and let both consumers run; the two direct key handlers (#2's
`F` arm and #15) must stand down in Live so the key is not handled three times.

⚠ **A field check is not enough for "a menu has focus".** `ModelerView.tsx:266-267` and
`SimulatorView.tsx:13505` both test `tagName ∈ {INPUT, TEXTAREA, SELECT}` (+ `isContentEditable` in the
modeler only — **the simulator's check omits it**, a latent difference worth aligning). Live's `Enter`
rule also has to stand down for the quick-add / connection-drop menus (which own `Enter`,
`GraphEditor.tsx:5280-5283`) and for every modal (`NameInputDialog`, `ConfirmDialog`, `SpriteSheetDialog`,
the capture-review modal).

---

## 7. S6 — Overseer ↔ Live mutual exclusion, both directions

### The mechanism that exists today (and what it actually is)

There is **no** "Overseer refuses to run while playing". What exists is:

- `handleRunExperiment` (`SimulatorView.tsx:3522-3624`) calls **`setPlaying(false)`** at `:3524` — Run
  *takes* the transport rather than refusing.
- While an experiment runs, `overseerRunningRef` gates the manual transport:
  `sendNextStep` (`:7444`), `handleStep` (`:13109`), `handleReset` (`:13133`) all early-return; the
  `stopEvent` handler suppresses its notice (`:7846`).
- The Run **button** is disabled by `running || !hasExperiment || !!compileError`
  (`ExperimentsPanel.tsx:417`), Abort by `!running` (`:426`).
- **Any model change aborts the experiment**: `SimulatorView.tsx:8944`
  `if (prev && overseerRunningRef.current) abortExperiment('model changed')` — plus
  `initWorkerWithDimensions` (`:8245`), `handleRecompile` (`:13162`) and the unmount cleanup.

### Why Live and the Overseer are genuinely incompatible

`:8944` is decisive: **in Live, every graph edit aborts a running experiment.** A sweep under a rule that
changes mid-run measures nothing, and the abort would look like a crash. So the exclusion is not
cosmetic.

### Both directions, per UI doctrine

- **Live → Overseer.** In Live the simulator's right panel is collapsed by policy (S7), so the
  Experiments tab is unreachable. That is *incidental*, not enforcement. Enforce it: `handleRunExperiment`
  early-returns while Live is shown, **and** the Experiments tab strip is **hidden** in Live
  (structurally impossible from this panel — the user cannot reach the working state without leaving
  Live, and the rule says hide). The `rightPanelTab` fallback effect (`:14993`) is the precedent for
  coercing the stranded selection back to `'controls'`.
- **Overseer → Live.** The Live nav button is **disabled in place** with the reason in its `title`
  ("An Overseer experiment is running — abort it or wait for it to finish"): the user *can* reach the
  working state from the visible UI (the Abort button is right there in the Experiments panel), so this
  is the grey-with-a-reason case, not the hide case. This mirrors the documented *"the Overseer's Run
  button mid-experiment"* example in the CLAUDE.md doctrine list.
- **A model with the Overseer disabled sees none of this** — `overseerEnabled`
  (`SimulatorView.tsx:3505`) is false, so the Live button is never greyed.

---

## 8. S7 — the two side-panel systems and the Live panel policy

| | Modeler | Simulator |
|---|---|---|
| Chrome | ActivityBar + up to two left `PanelShell`s + right `PanelShell` + RightActivityBar (`ModelerView.tsx:316-368`) | left `.sidePanel` (Settings) + top viewer bar + bottom transport bar + right panel (`SimulatorView.tsx:15196…16698`) |
| State | `activePanel` / `activeRightPanel`, persisted in `modelerUiState` (`:181-187`) | `leftPanelOpen` / `rightPanelOpen` / `topBarOpen` / `bottomBarOpen` (`:14985-14996`) — **plain `useState(true)`, NOT persisted** |
| Widths | inline `style.width`, lost on unmount (`PanelShell.tsx:51-56`) | inline `style.width`, lost on collapse (`:15168-15183`) |
| Collapse-all | `toggleCanvasFullscreen` + `prePanelStateRef` (`ModelerView.tsx:150, 223-234`) | `toggleCanvasFullscreen` + `prePanelStateRef` (`:15080-15096`) |

### The Live policy

- **The graph keeps the modeler's panels** (they are the model-authoring surface).
- **The simulator's left + right panels are collapsed in Live** and the brush / indicators are reached as
  **popovers from a new Live viewport bar** at the top of the viewport pane.
- The viewport bar also carries the **layout menu** (dock right / dock bottom / swap / collapse) and the
  **transport chip** (`● synced / ● stale / ● pending / ⟳ rebuild needed`).

### ⚠⚠ Trap — panel state must not leak between Simulator and Live

Both modes share **one** `SimulatorView` instance, so collapsing its panels on entering Live and leaving
them collapsed would silently change the Simulator tab. Use the existing discipline: a
`preLivePanelStateRef` snapshot taken on Live-enter and restored on Live-exit, in the exact shape of
`prePanelStateRef` (`:15080`) — including the "null/false entries are preserved" rule, or a user who had
already collapsed the right panel gets it re-opened on the way out.

### ⚠ Trap — the transport bar is the pane's, not the window's

`transportBarRow` is centred inside `.canvasArea` and the bottom-band collision effect
(`:15026-15069`) lifts the capture cluster over it once they overlap — **measured to touch at a canvas
width of 843 px**. A Live viewport pane is routinely narrower than that, so **the lift will engage in
Live and must be verified**, not assumed. It is `ResizeObserver`-driven on `canvasAreaRef`, so it does
fire on a splitter drag; the rAF re-check at `:15048-15053` exists precisely because an observer can
measure a half-settled layout.

### ⚠ Trap — indicator + Experiment charts measure their own width

`overseer.md` (`useMeasuredWidth`) and `modeler-ui.md` ("Canvas chart components ALWAYS mount the outer
`<div ref={wrapRef}>`"): a chart that mounts at width 0 stays at 0 forever unless a `useLayoutEffect`
fallback re-measures. **An indicators popover in Live is a fresh mount inside a narrow pane** — exactly
the documented failure shape. Any Live popover hosting a chart must render the wrapper unconditionally
and let the existing hook measure it.

### UI-doctrine disposition of every new control (summary; per-phase detail in the plan)

| Control | Where | Disposition |
|---|---|---|
| **Live** nav button | navbar | **grey + reason** while an Overseer experiment runs; always visible otherwise |
| Layout menu (dock right / dock bottom / swap / collapse) | Live viewport bar | visible; **each item greyed with the reason while recording** (frame dims are locked — S12) |
| Splitter | between panes | **hidden** when the viewport is collapsed (there is nothing to divide); a restore ear takes its place |
| Apply-policy switch (Auto / On demand) | Live viewport bar | always live |
| Transport chip | Live viewport bar | always visible in Live; **not rendered in the Simulator tab** (structurally meaningless — the red banner is the Simulator's surface) |
| Experiments tab strip | simulator right panel | **hidden in Live** + `rightPanelTab` coerced to `'controls'` |
| Brush / Indicators popovers | Live viewport bar | shown only when the model has that layer (the existing `showAgents` / `indicators.length` gates) |
| FPS cap = 30 | Live viewport bar (existing FPS popover) | live and editable — Live only changes the **default** |
| Pop out to a window (Phase 6) | Live viewport bar | **hidden** where `documentPictureInPicture` is absent (structurally impossible) |

---

## 9. S8 — the splitter, and the resize machinery it must reuse

### What already handles a resize, and why the splitter must call it

`simulator-ui.md` §"Panel resize responsiveness" is the authority. `draw()` is **the one place** that
re-sizes every backing store *and* performs the direct-render `OffscreenCanvas` re-attach, and it used to
run only on step messages, canvas interactions and window resize. Three triggers now funnel into it:

1. `useLayoutEffect` on `[visible, leftPanelOpen, rightPanelOpen, topBarOpen, bottomBarOpen, rightPanelTab]`
   → a **direct** `drawRef.current()` before paint (`SimulatorView.tsx:15005-15013`). It also clears the
   drag deferral (`layoutResizeUntilRef.current = 0`, `:15011`).
2. Both splitter `onMove` handlers → `scheduleLayoutDraw()` (`:15179`, and the right panel's twin) — they
   mutate `panel.style.width` directly, so nothing else would fire.
3. A `ResizeObserver` on `canvasAreaRef` as the catch-all (`:9384-9391`).

`scheduleLayoutDraw` (`:9355-9380`) is rAF-coalesced **and** opens a 140 ms
`layoutResizeUntilRef` window (`LAYOUT_RESIZE_SETTLE_MS`, `:1213`) during which
`resizeAttachDeferred()` (`:2609`) suppresses the `OffscreenCanvas` re-attach at all four sites
(`:6155` 3D spheres, `:6194` voxels, `:6911` 2D composite, `:7019` 2D agent-direct), because a transferred
canvas has **fixed dims** and tracking a drag exactly costs one worker pipeline rebuild per frame
(**measured: 26 `attachAgentCanvas` messages over a 30-move drag** → 2 after the fix). Meanwhile 2D blits
scaled (`drawImage(src, 0, 0, parentW, parentH)`) and the 3D layers stretch via CSS.

### ⚠⚠ Trap — the Live splitter lives OUTSIDE SimulatorView

It is a sibling in `<main>`, so it cannot call `scheduleLayoutDraw` directly. Relying on trigger (3) alone
is exactly what the fix's own doc warns against: *"deliberately NOT ResizeObserver alone, because RO
delivery is part of the browser's rendering steps and (1)+(2) are the paths that must be immediate"* —
and the verification note records that **an occluded pane delivers neither `requestAnimationFrame` nor
`ResizeObserver`**.

**⇒ expose the seam.** A module-level `simLayoutApi` in a new `src/simulator/simLayoutState.ts`, registered
by `SimulatorView` on mount and nulled on unmount — the `quickAddApi` pattern
(`graphState.ts`; registered in `GraphEditor`, consumed in `ModelerView.tsx:159-163`). The Live splitter's
`onMove` calls `simLayoutApi?.scheduleLayoutDraw()`; its `onUp` and the layout-menu actions (discrete
changes) call a `simLayoutApi?.drawNow()` that mirrors trigger (1) — clearing the deferral first, so a
dock-swap does not wait out the 140 ms settle.

### Persistence

- **The brainstorm's premise is wrong** (§16): panel widths do *not* persist. The splitter needs its own
  store.
- Model: a new `src/live/liveUiState.ts` module global with localStorage write-through under
  **`genesisca_live_layout`**, exactly the shape of the graph view settings
  (`modeler-ui.md`: *"Canvas view toggles … persist via `graphState.ts` module globals … with
  localStorage write-through (`genesisca_graph_view_settings`)"*). Fields: `dock: 'right' | 'bottom'`,
  `swapped: boolean`, `split: number` (0–1 fraction, **not** pixels — a fraction survives a window
  resize), `viewportCollapsed: boolean`, `applyPolicy: 'auto' | 'ondemand'`, `simPanelsCollapsed: boolean`.
- **It is NOT `genesisca_sim_settings`.** That key is owned by `SimulatorView`'s single 300 ms persist
  effect (`:3197-3221`) whose documented **declaration-order trap** requires every persisted state to be
  declared above it (~`:3197`). Live layout is App-level state; putting it there would mean threading it
  down and up again for no benefit.
- **Nothing reaches `.gcaproj`.** Live layout is a per-user view preference, in the same class as
  `showBackdrop` / `backdropOpacity` (`:2789-2793`, whose comment states the rule: the *image* is model
  data, *how strongly to show it* is a user setting). `fileOperations.ts` is untouched.
- Double-click on the splitter → `split = 0.5`. Collapse → `viewportCollapsed = true` and the splitter
  hides; a restore ear (the `leftPanelExpandBtn` / `panelExpandBtnRight` pattern) brings it back.

---

## 10. S9 — performance guards

| Guard | Seam | Notes |
|---|---|---|
| **FPS cap 30 by default in Live** | `targetFpsRef` (`:7317`, written at `:7365`), consumed as `msPerFrame = 1000 / targetFpsRef.current` (`:7790`) | Live only changes the **default** on first entry, and only if the user has not set a lower value; the FPS popover stays live. Restore the previous value on Live exit (the `preLivePanelStateRef` discipline). |
| **Skip the BLIT, not the step, during a node drag** | the per-`stepped` `draw()` at `:7629` | Guard it with a `liveSkipBlitRef`; keep the `setGeneration` throttle (`:7625-7628`) and the whole recording block (`:7664+`) running, and keep `sendNextStep()` (`:7833`) untouched — the worker must not lose cadence. **Do not** reuse the unlimited-gens fast path (`:7604-7620`): it skips the colour pass too and has its own voxel-free-mode carve-out. |
| Node-drag signal | `GraphEditor.tsx:1955-1956` — `isDrag` / `isDragEnd` are already computed from the position changes | Publish it through `liveState` (`setLiveGraphDragging`), the `activeGraphKind` pub/sub shape. |
| **Debounce stretch to ~400 ms while the pointer is down** | `scheduleSync` (`GraphEditor.tsx:1091`) | ⚠ **See §16 — the premise is largely wrong.** `needsSync` (`:2061-2066`) fires only on `remove`, position **drag-END**, `dimensions` and `replace`. A node *position* drag syncs **once, at release**. What does storm is a **held inline widget** (a number field / slider inside a node) and a **comment/group resize** (`dimensions`). Stretch the debounce for those. |
| The 092a8c7 no-op guard | `graphEquality.ts` + the four write-backs | Already merged: a `dimensions`-only write-back that is deep-equal returns the same state ref, so React Flow's mount-time measurement no longer triggers a soft recompile. Live inherits this; **do not undo it**. |
| Two panes both painting | — | The Live viewport is *smaller* than the Simulator tab's, so per-frame blit cost goes **down**. The new cost is React Flow re-rendering beside a 30 fps canvas; the existing `memo`/pub-sub discipline (`modeler-ui.md` "Connected-handles pub/sub") already keeps per-node re-renders off the model path. |
| Large-grid CPU path | `simulator-ui.md` | The CPU path ships a colours buffer per frame; the WebGPU/direct-render paths do not. **Live changes nothing here** — the capture-scope `needColors` want-flag (`:setRecording`) is the only thing that re-arms the readback, and Live does not touch it. |

---

## 11. S10 — 2D vs 3D (the dual-impact rule applies to every phase)

The Live pane hosts **the same canvas stack**, so nothing is 2D-only — but three things differ.

**The 2D stack** (`SimulatorView.tsx:15537-15568`): `canvasRef` (the final composited 2D surface) ·
`cursorHlCanvasRef` + `cursorNegCanvasRef` (overlay layers, `mix-blend-mode: difference`) · the
`agentSphereLayerRef` / `voxelLayerRef` host divs (`display: none` in 2D).

**The 3D stack**: `agentSphereLayerRef` (z-index 1, worker-presented `OffscreenCanvas` appended
imperatively) **or** `voxelLayerRef` (z-index 1, mutually exclusive) · `glCanvasRef` (WebGL2, z-index 2,
transparent clear in overlays-only mode so the layer below shows through) · the 2D cursor canvases hidden.

| Concern | 2D | 3D |
|---|---|---|
| Backing-store resize | `canvas.width = parentW` inside `draw()` | `r.resize(cssW, cssH, dpr)` on the gl3d renderer inside `draw()` — same function, same trigger |
| Splitter drag | scaled blit `drawImage(src,0,0,parentW,parentH)` keeps the picture right-sized | the sphere/voxel layers are `width/height: 100%`, so CSS stretches them |
| Orbit / pan input | RMB drag pans, wheel zooms (`:13054-13057` on the container) | its own pointer effect on `glCanvasRef` (`:10208-10214`), plus the numpad view keys in listener #14 (`:13706-13726`) |
| Live risk | narrow pane ⇒ the bottom-band collision lift engages (S7) | **narrow + short pane ⇒ the gizmo, axis labels and the 3D View panel compete for space**; verify on Life3D and Accretor |
| Camera re-send | — | entering Live re-sends `setGridCamera` / `setAgentCamera` via the visible-effect (`:10707-10716`) — needed because a `refresh*Display` without a camera re-upload presents the **old** view |
| gl3d overlays | — | `setOverlaysOnly(on, wireframesExternal)` — the agent-sphere free mode still draws its wireframes, the voxel free mode does not (the worker owns them). A pane resize does not touch this, but a *3D Live* regression here shows up as vanishing axes. |

⚠ **Verification traps carried over from the docs:** an occluded Browser pane suspends `rAF` **and**
`ResizeObserver`, and `readPixels` on the default framebuffer returns all-zero — so a Live 3D check must
`resize_window` first, drive the loop with an rAF shim, and prove the render path by spying on
`Gl3DRenderer.setCamera` rather than by reading pixels. Cited from `simulator-ui.md` §3D auto-zoom and
§Panel resize.

---

## 12. S11 — worker message surface

**No new worker message is needed, and none changes shape.** Four existing present-only messages must
simply fire on a new trigger (entering / leaving Live, and the splitter settle):

| Message | Worker handler | Fired from | Live |
|---|---|---|---|
| `refreshDisplay` | `sim.worker.ts:8402` | `SimulatorView.tsx:10704` | fires on Live-enter for free (same `visible` transition) |
| `setGridCamera` + `refreshGridDisplay` | `:8503`, `:8575` | `:10709-10710` | ditto — and the camera **must** precede the refresh, as it already does |
| `setAgentCamera` + `refreshAgentDisplay` | `:8675`, `:8765` | `:10715-10716` | ditto |
| `attachCanvas` / `attachVoxelCanvas` / `attachAgentCanvas` | `:8437`, `:8461`, `:8586` | inside `draw()` at `:6155 :6194 :6911 :7019`, each `!resizeAttachDeferred()`-guarded | the splitter must go through `scheduleLayoutDraw` (S8) or it re-attaches once per drag frame |

⚠ **The re-attach commit rule must not be disturbed** (`agent-render.md` §"Direct-render resize
re-attach"): the OLD canvas is kept live through the handshake and removed only by the **ack commit**;
a failed attach forces the UI-sync ON (`forceAgentUiSyncOn` / `forceGridUiSyncOn`) so a permanent CPU
fallback still receives fresh data instead of freezing on an ancient frame. A Live splitter that bypassed
`scheduleLayoutDraw` would drive this path 30× a second.

⚠ **`setRecording { needColors }`** (`sim.worker.ts:setRecording` case) is the capture-scope want-flag —
Live must not touch it. Re-deriving it anywhere would resurrect the documented "the GIF records the agents
but not the grid" bug.

---

## 13. S12 — capture and recording in Live

**Doctrine says keep them.** Screenshot and recording are not *structurally* impossible in Live — the
canvas is there and the `'simulation'` capture scope renders the whole world at a fit framing on the main
thread, **independent of the current zoom/pan and of the pane size**
(`renderSimulationFrame`, `simulator-ui.md`). Hiding the capture cluster would be an arbitrary limit, not
a doctrine-driven hide.

What *is* real is an interlock:

- The `'view'` scope **locks the output dims on the first captured frame** (`recordCropRef`, `:2979`;
  `recordDimsRef`, `:2983`; the dimension guard drops mismatched frames at `:7687`+). **A splitter drag
  mid-recording therefore changes the source box while the frame size is pinned.**
- ⇒ **While `recording` is true, the Live layout controls (splitter, dock, swap, collapse) are DISABLED
  IN PLACE with the reason in the tooltip** — the same disposition the existing "capture settings while
  recording" rule uses. The FPS-cap default change is likewise not applied while recording (the recording
  fps derives from `targetFpsRef`, `:13372`).
- The capture-review modal already owns the keyboard (`captureReviewRef` checks at `:13512` and
  `:15102`); Live's new handlers must include the same check or `Enter` will play behind the modal.
- `deliverCapture`'s `review` path **pauses the simulation while the modal is up** (`:3454-3473`) — in
  Live that pause is correct and needs no change.

---

## 14. S13/S14 — persistence, and the ZERO-emit claim

- **`.gcaproj` / `.gcastate` / `.gcapreset` / `.gcamacro`: untouched.** No schema field, no
  `fileOperations.ts` change, no migration. Live state is per-user view preference (S8).
- **The standalone `.html` export ships `SimulatorView` only** (`src/viewer/ViewerApp.tsx` — "chromeless
  shell"), so Live is structurally absent there and the export needs no change. This settles the
  brainstorm's open question.
- **`ModelContext`: untouched.** Live adds no action, no cascade. The 092a8c7 graph-equality guard is the
  only recent change in this area and Live depends on it rather than modifying it.
- **The ZERO-emit claim, proved not asserted:**
  `node scripts/check-compile-identity.mjs --compare <baseline captured before the first Live commit>`
  must report **"31 models, all surfaces unchanged"** on every surface (JS step / grid-init / WASM bytes /
  WGSL / agent behaviour / division / init / overseer), and `git diff --stat` must touch **no file under
  `src/modeler/vpl/compiler/**` or `src/modeler/vpl/nodes/**`**. That harness hashes **error strings**
  too, which is why the last-good-rule work must change *when* a compile result is delivered, never *what*
  it says.

---

## 15. The top five traps

1. **A Live pane wrapper that changes `SimulatorView`'s position in the React tree destroys the worker,
   the WASM memory, the WebGPU device and the running grid.** The element tree must be identical between
   `simulator` and `live`; only `className`/`style` may differ. (`App.tsx:436-444`; §2)
2. **`SimulatorView`'s main keyboard handler is not visibility-gated** (`:13503-13741`), so **`Esc` in the
   Modeler resets the running simulation today**, `Enter` advances it by one batch, and `Ctrl+C/V/X` is
   double-bound against `GraphEditor.tsx:3890` in the same phase on the same target. Live makes all three
   unmissable. (§6)
3. **A failed compile *nulls* the running rule in the worker** — `stepFn = stepCode ? eval(…) : null`
   (`sim.worker.ts:5899`) with `safeCompileGraph` returning `stepCode: ''` on a throw
   (`SimulatorView.tsx:1843-1857`). Last-good-rule must therefore **withhold the `recompile` post**, not
   post-and-recover. (§5, Trap A)
4. **The rebuild prompt must not advance `prevModelRef`** (`SimulatorView.tsx:8938-8939`), or the deferred
   structural change is silently lost and the worker runs a layout the model no longer describes — the
   baked-offset desync class the 25 `needsFullInit` comparisons exist to prevent. (§5, Trap C)
5. **The Live splitter is outside `SimulatorView`, so it cannot reach `scheduleLayoutDraw`** — and
   relying on the `ResizeObserver` catch-all alone reintroduces the stretched-stale-bitmap bug *and*
   drives one `OffscreenCanvas` re-attach + worker pipeline rebuild per drag frame (measured 26 over a
   30-move drag). A registered `simLayoutApi` seam is required. (§9)

*Runner-up:* **`setCompileError` is the simulator's general error channel** (18 call sites, only 6 of them
graph compiles), so a blanket "no red banner in Live" would swallow failed CSV / GeoTIFF / GeoJSON /
preset imports. (§5, Trap B)

---

## 16. Where the brainstorm's assumptions turned out WRONG

| Brainstorm claim | Reality | Consequence |
|---|---|---|
| *"The splitter position persists like the panel widths."* | **Panel widths do not persist.** Both `PanelShell.tsx:36-65` and `SimulatorView.tsx:15168-15183` mutate inline `style.width` and the element is unmounted on close — the simulator's own comment says re-opening "starts from the CSS default". | The splitter needs a real store; the plan adds `genesisca_live_layout` (S8). |
| *"The debounce should stretch to ~400 ms while the pointer is down"* (framed as fixing a compile-every-100 ms storm during node drags). | A node **position** drag never syncs mid-drag: `needsSync` fires on `remove`, position **drag-END**, `dimensions` and `replace` only (`GraphEditor.tsx:2061-2066`). | The stretch is still worth having, but for **held inline widgets** and **comment/group resizes** (`dimensions`), not for node dragging. Scoping it to "pointer down" as written would target the wrong gesture. |
| *"`SimulatorView` … auto-pauses on `visible=false`"* — implying the two views are otherwise mutually exclusive. | Auto-pause is real (`:10718-10720`), but **the keyboard is not exclusive at all**: the simulator's `Space`/`Enter`/`Esc`/`Ctrl+C-V-X` handler runs in the Modeler today (§6, Finding 1). | Keyboard ownership is a **bug fix**, not just new-feature scaffolding — it lands in Phase 4 and is testable independently of Live. |
| *"A half-wired graph … the run must keep the previous compiled function"* — implied as a small addition. | The worker actively **discards** the previous function on every recompile (`sim.worker.ts:5889-5934`). "Keeping" it means never sending the message. | The fix is a main-thread gate, which is *cheaper* than the brainstorm implies **and** keeps `sim.worker.ts` untouched. |
| *"Live mode … hides the simulator's [panels]"* — presented as free. | The panel state is plain `useState` on the **shared** `SimulatorView` instance (`:14985-14996`), so hiding leaks into the Simulator tab. | A save/restore ref is mandatory (S7). |
| *"Does the standalone `.html` export ever want this? Probably not."* | Confirmed structurally: the viewer mounts `SimulatorView` only (`src/viewer/ViewerApp.tsx`). | Closed. No export work. |
| *"Macro scope: breadcrumb + boundary nodes take vertical space the overlay could use."* | An Option-A concern. In a **split**, the breadcrumb costs the graph pane's own budget and `savedCurrentScope` (`graphState.ts:31-35`) already survives every remount. | Closed. Editing inside a macro while it runs is the same pipeline, no special case. |

---

## 17. Open decisions taken here (and why)

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| D1 | Live is a **CSS re-layout of `<main>`**; both view wrappers stay at fixed React tree positions in every mode | Portals; a dedicated `<LiveView>` that renders the two views | Any structure that moves `SimulatorView` remounts it and kills the worker. CSS also makes dock-bottom / swap free. |
| D2 | Keep the prop name **`visible` = "shown"** and add **`activeTab`** | Rename `visible` → `shown` everywhere | `visible` has ~10 consumers plus `visibleRef`; renaming is churn with no behavioural gain, and "shown" is what all but two of them already meant. |
| D3 | Last-good-rule = **withhold the `recompile` post on the main thread** | Keep the previous `stepFn` inside the worker | Zero `sim.worker.ts` diff; the worker's last-good state is preserved by construction; no new message; `check-compile-identity` stays trivially green. |
| D4 | A dedicated **`setRuleCompileState`** channel; `compileError` keeps its 12 non-compile call sites | Suppress the banner while Live is shown | A blanket suppression hides failed GIS/CSV/preset imports (§5, Trap B). |
| D5 | Deferral tracked by a new **`appliedModelRef`**; `prevModelRef` advances only on a real apply | Recompute `needsFullInit` against a stashed diff | A second baseline is the minimum honest fix; anything cleverer risks the exact desync class §5 Trap C describes. |
| D6 | Live layout in a new **`src/live/liveUiState.ts`** + `localStorage['genesisca_live_layout']`; focus/drag flags in **`src/live/liveState.ts`** (module global + pub/sub) | Add fields to `genesisca_sim_settings`; React context | `genesisca_sim_settings` is `SimulatorView`-owned with a declaration-order trap (`:3197`); the pub/sub global is the project's established cross-tree pattern (`graphState.ts:57-72`) and works with `memo`'d consumers. |
| D7 | Splitter position stored as a **fraction (0–1)**, not pixels | Pixels, like the panels | A fraction survives a window resize and a dock flip; pixels would need re-clamping on every resize. |
| D8 | **Overseer → Live: grey the Live button with a reason. Live → Overseer: hide the Experiments tab** | Abort the experiment on entering Live; grey both | Doctrine: the user *can* reach the working state (Abort is visible) ⇒ grey. Inside Live, Run is unreachable and meaningless ⇒ hide, with the `rightPanelTab` fallback coercion the code already uses at `:14993`. |
| D9 | **Capture stays available in Live**; the *layout controls* grey out while recording | Hide the capture cluster in Live | Capture is not structurally impossible, so hiding it would violate the doctrine. The honest interlock is the frame-dims lock (`recordCropRef`, S12). |
| D10 | A registered **`simLayoutApi`** seam for the splitter | Rely on the `ResizeObserver` catch-all | The catch-all is explicitly documented as insufficient for immediate paths, and an occluded pane delivers no RO callbacks at all (S8). |
| D11 | **FPS cap 30 is a default, not a clamp** — the popover stays live and the prior value is restored on exit | Force 30 while Live is shown | An inert/overridden control is exactly what the "an enabled control must do something" rule forbids. |
| D12 | Phase 6 (Document PiP) is **feasibility-gated and may be dropped**, with the spike's result documented either way | Commit to shipping it | The spike must prove that **both** the CPU blit canvas **and** the worker-transferred `OffscreenCanvas` placeholders keep presenting after `adoptNode` into the PiP document, and that the WebGL2 context survives — none of which is guaranteed. If fragile: defer and record why. |

---

## 18. Reading trail (Read to CLOSURE)

Walked, in this order, until a pass turned up nothing new:
`simulator-ui.md` → `agent-render.md` (re-attach + UI-sync) → `simulation-engine.md` (worker messages) →
`modeler-ui.md` (panel/layout state, editor gotchas) → `overseer.md` (mutual exclusion, chart width) →
`grid-3d.md` (the layered canvas stack, camera re-send) → `indicators.md` (chart measurement) →
`project-structure.md` (where the new files go). Then the source for every touch point cited above.

**Docs that will need a line when this lands** (Phase 5): `simulator-ui.md` (the `shown`/`activeTab`
split, the Live panel policy, the capture interlock), `modeler-ui.md` (the Live pane + the keyboard-owner
rule), `overseer.md` (the Live exclusion, both directions), `grid-3d.md` (the 3D Live pane + camera
re-send), `project-structure.md` (the new files), plus `HelpView.tsx`, `README.md`,
`KeyboardShortcutsOverlay.tsx`.

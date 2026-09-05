# Plan — the Properties panel, restructured

> **STATUS: IMPLEMENTED** (branch `tasks_batch_02-09`, 2026-09-05). The "As built" section at
> the end records the deviations and the measurements.

Illustrated mockup: [PLAN_PROPERTIES_PANEL_REFACTOR.html](PLAN_PROPERTIES_PANEL_REFACTOR.html)
(self-contained; open in a browser — before / after, both themes' tokens).

## The problem, measured

The Modeler's **Properties** panel is one scrolling column that has absorbed every model-level
concern the app gained over two years. Measured on the shipped library at the default panel width
(320 px, an 874 px-tall body):

| model | scroll height | screens | words | controls |
|---|---|---|---|---|
| Game of Life (grid only) | 3 229 px | 3.7 | 1 006 | 32 |
| Morphogenesis — Growing Tissue (agents) | **6 621 px** | **7.6** | **2 185** | **111** |

Six problems, each a different layer:

1. **Information architecture** — one panel holds five unrelated concerns: what the model *is*
   (layers, dimension, the feature gates), how it *runs* (engines, update modes, reproducibility,
   performance options), the whole **agent physics sub-application**, the **measurement** layer
   (indicators + end conditions), and three **read-only readouts** (Compatibility, Generation
   Pipeline, the per-agent footprint).
2. **Order** — the decisions that gate everything else (Grid / Agents layers, Variegated Cells,
   Overseer, 3D) sit *inside* "Execution", after the reproducibility contract, the async scheme and
   the WebGPU stop-check interval. Topology lives under Execution; Variegated Cells is the LAST
   section of the panel. A user who never scrolls there never learns those features exist — and
   then cannot find the nodes they gate.
3. **Discoverability of gates** — the palette silently *hides* nodes a model's setup rules out. The
   user's report is exactly this: "later struggle to figure out why certain nodes or capabilities
   are not available to them". Nothing anywhere says *"N nodes are hidden by this model's setup"*.
4. **Density** — every option carries a paragraph of always-visible explanation (the capture
   popover's doctrine — *every explanation is a tooltip, rows never reflow* — was never applied
   here), radios with long descriptions where a two-state segment would do, and three levels of
   uppercase mini-headings nested inside inline-styled divs.
5. **Read-only content interleaved with editing** — Compatibility and Generation Pipeline are
   *audits* of the settings, yet they sit between Execution and Indicators as if they were settings.
6. **Indicators are buried** — a first-class model-element list (the peer of Attributes,
   Neighborhoods and Mappings, with the same master-detail editor) is the fifth section of a
   settings panel, reachable only by scrolling past the physics.

## The design

### A. Indicators become their own left-bar tab

`Indicators` joins the ActivityBar as a panel of its own (a line-chart icon), between Mappings
and Variegated Cells. It hosts the existing list + master-detail editor (unchanged component) and
gains **End Conditions** as its second section — they are indicator rules plus a max-generation
cap, i.e. the measurement layer's stop rules, and the only thing they reference is the list above
them. The Properties panel therefore stops being master-detail altogether.

### B. Properties becomes four sub-tabs

A labelled sub-tab strip at the top of the panel body (the Mappings / Simulator right-panel
precedent), persisted across a Simulator round-trip in `modelerUiState.propertiesTab`:

```
 PROPERTIES
 ┌────────┬───────────┬────────┬─────────────┐
 │ Setup  │ Execution │ Agents │ Diagnostics │      Agents: only when the Agents layer is on
 └────────┴───────────┴────────┴─────────────┘
```

| tab | question it answers | contents (in order) |
|---|---|---|
| **Setup** | *what is this model?* | **Layers** (Grid Cells · Bond-Graph Agents — as layer cards) · **Grid** (Dimension 2D/3D segment, W×H×D, Boundary segment) · **Extensions** (Variegated Cells · Overseer · Geographic tools — as feature cards with their own config revealed when on) |
| **Execution** | *how does it run?* | **Reproducibility** segment · *Reset restores saved board* (only when a board exists) · **Grid engine** (Update mode segment + async scheme, Engine segment + resolution badge, an *Advanced* reveal for Debug/JS + the WebGPU stop-check interval) · **Agent engine** (same shape, only with Agents on) · **Performance** (Skip Isolated Empty Cells) |
| **Agents** | *how do agents behave?* | **Capability profile** (presets + rows) · **Population** (capacity + seeding) · **Motion** (momentum / max speed / time step + the Δt clamp readout / drag) · **Bonding physics** (the master toggle + Forces + Bonds) · **Advanced** (Layout iterations, Bond requests per step) |
| **Diagnostics** | *what will actually run?* | read-only: **Compatibility** (+ copy) · **Generation Pipeline** (+ copy) · **Per-agent footprint** (agents only) |

The order inside Setup is the order of *impact*: the layer cards come first because they decide
which graphs, which node catalogue and which other tabs exist at all.

### C. Cards say what they unlock

Every layer card and every extension card carries a one-line **Unlocks:** hint — the graphs,
panels and node families the toggle turns on. A user reading the Setup tab learns in one screen
that *Bond-Graph Agents* is where the Agents graph and the agent node catalogue come from, and
that *Variegated Cells* is where the orientation / face-label nodes live. The 3D option says it
disables Variegated Cells; the Variegated card is disabled in place (with the reason) in 3D.

### D. The palette closes the loop

The node Palette gains a small notice whenever the model's setup hides nodes on the active graph:
*"N nodes are hidden by this model's setup"* with an **Open Setup** button that opens
Properties → Setup (or → Agents when the hidden nodes are agent-capability-gated). The count is
computed by diffing `isNodeAvailable` under the current model against the same model with every
gate opened (both layers, Variegated, Overseer, the full agent profile) — so it can never name a
node the graph kind itself excludes.

### E. Density rules (the capture-popover doctrine, applied)

- A control is a **label + a control + at most ONE short muted line**. Anything longer moves to a
  `title` tooltip on the row (and to the Help tab, which keeps the long form).
- **Binary / small-enumeration choices are SEGMENTS, not radios-with-paragraphs**: Dimension,
  Boundary, Reproducibility, Update mode (grid + agents), Engine (grid + agents), Seed pattern.
  The selected option's one-liner shows below the segment; every option carries its own tooltip.
- **Advanced reveals** hold what ~5 % of users touch: Debug/Reference JS, the WebGPU stop-check
  interval, layout iterations, bond request depth.
- Shared primitives in one module (`propertiesWidgets.tsx`): `SubTabs`, `Section`
  (collapsible, persisted by id), `Segmented`, `ToggleCard`, `FieldRow`, `Hint`, `Advanced`,
  `CopyButton`. No inline `style={{…}}` typography in the tab bodies — classes in
  `PanelContent.module.css`.

## Impact map (subsystem by subsystem)

| subsystem | change | risk |
|---|---|---|
| `PropertiesPanelContent.tsx` | becomes a thin shell (sub-tab strip + routing); the bodies split into `PropertiesSetupTab` / `PropertiesExecutionTab` / `PropertiesAgentsTab` / `PropertiesDiagnosticsTab` | pure presentation; every dispatch is the same reducer action with the same payload |
| `AgentCapabilitiesSection.tsx` | loses the footprint readout (→ Diagnostics) and the Solver row (→ Agents › Advanced); restyled to the shared primitives | none (same edits) |
| `IndicatorsPanelSection.tsx` | unchanged; wrapped by the new `IndicatorsPanelContent` which also hosts `EndConditionsSection` (extracted verbatim from Properties) | none |
| `ActivityBar.tsx` | `PanelId += 'indicators'` + icon + entry | none |
| `ModelerView.tsx` | `panelTitles` / `panelComponents` / `MASTER_DETAIL_PANELS` (`indicators` replaces `properties`); `selectedItemName` resolves the indicator slot for `'indicators'`; a `genesis-open-modeler-panel` window event opens a named panel (used by the palette notice + the Variegated card's "Open panel" link) | the detail-panel gate — an unresolved slot never mounts the editor, so the indicator branch must move with the panel id |
| `modelerUiState.ts` | `propertiesTab` snapshot | none |
| `PalettePanelContent.tsx` | the hidden-nodes notice | additive |
| `nodeValidation.ts` | the four badge messages that name a Properties location are re-pointed (`Setup › Layers`, `Setup › Extensions`, `Agents`) — **strings only**, not gate logic | a compile-visible error string is a captured surface; these are BADGE strings (`detectCapabilityRequirements`), which `check-compile-identity` does not hash — verified by running it |
| `HelpView.tsx` / `README.md` / `CLAUDE.md` | every "Properties → X" path re-pointed; the Properties Panel section rewritten around the four tabs | docs |
| compilers / worker / engine / schema | **untouched** — no model field changes, no new persisted property | `check-compile-identity` must report 31 models unchanged |

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` + `npm run build`.
- `node scripts/check-compile-identity.mjs --compare <baseline>` — 31 models, all surfaces
  unchanged (the refactor emits nothing).
- Real UI, both a grid-only and an agents model: every control dispatches the same action it did
  (spot-checked by flipping each and reading the model back), the Agents tab appears / vanishes
  with the layer, the Indicators tab opens the editor in the second panel, End Conditions still
  edit `properties.endConditions`, the palette notice counts hidden nodes and opens Setup.
- Scroll-height + word-count on the two reference models, before vs after.

## As built

Implemented as planned, on branch `tasks_batch_02-09` (2026-09-05). Presentation only: no schema,
compiler, worker or engine file changed; `check-compile-identity` reports 31 models unchanged on
every surface; `tsc` + `npm run build` clean.

**Files.** `PropertiesPanelContent.tsx` is the shell (sub-tab strip + routing, tab persisted in
`modelerUiState.propertiesTab`). Bodies: `PropertiesSetupTab.tsx`, `PropertiesExecutionTab.tsx`,
`PropertiesAgentsTab.tsx`, `PropertiesDiagnosticsTab.tsx`. Primitives: `propertiesWidgets.tsx`
(+ the `genesis-open-modeler-panel` event / `openModelerPanel`). Indicators: `IndicatorsPanelContent.tsx`
hosting `IndicatorsPanelSection` + the extracted `EndConditionsSection.tsx`. Touched:
`ActivityBar.tsx` (`'indicators'`), `ModelerView.tsx` (panel tables, `MASTER_DETAIL_PANELS`,
`selectedItemName`, the open-panel listener), `modelerUiState.ts`, `AgentCapabilitiesSection.tsx`
(footprint + Solver row removed), `PalettePanelContent.tsx` (the notice), `nodeValidation.ts`
(`countNodesHiddenBySetup` + the four re-pointed badge strings), `PanelContent.module.css`.

**Measurements (scroll height / words / controls of the panel body).**

| model | before (one scroll) | after |
|---|---|---|
| Game of Life (2D grid) | 3229 px / 1006 / 32 | Setup 1104 / 234 / 18 · Execution 874 / 125 / 13 · Diagnostics 998 / 368 / 5 |
| Morphogenesis — Growing Tissue (agents-only) | 6621 px / 2185 / 111 | Setup 874 / 185 / 9 · Execution 874 / 71 / 12 · Agents 2343 / 492 / 83 · Diagnostics 2264 / 779 |

**Real-UI verification** (dev server, 0 console errors): on Growing Tissue the ActivityBar reads
Info / Properties / Attributes / Mappings / Indicators, the Indicators tab's "+ Standalone" opens the
editor in the second panel and End Conditions toggles + adds indicator conditions; the palette notice
reads "10 nodes hidden by this model's setup (capability profile)" and its *Open Agents ›* opens
Properties on the Agents sub-tab. On Game of Life the Bond-Graph Agents card switch makes the Agents
sub-tab and the Cells/Agents graph pills appear and vanish; 3D volume reveals Depth and greys the
Variegated card with its reason; Execution shows Reproducibility / Update mode / Engine segments,
async greyed under WebGPU with the reason, Auto → a `Auto → WebGPU` badge + reason, Advanced holds
Debug JS + the stop-check interval (greyed with the reason off WebGPU), WASM re-enables async. Life3D
(3D) shows Depth, the greyed Variegated card and no Agents tab.

**Deviations from the plan.**
- The Diagnostics readouts (`CompatibilityBlock`, `GenerationPipelineBlock`) and
  `AgentCapabilitiesSection` were MOVED, not restyled — they keep their pre-existing inline
  styling. The plan's "no inline `style={{…}}` typography in the tab bodies" holds for the new tab
  code, not for those three carried-over blocks.
- The Agents tab is still the longest by far (2343 px on Growing Tissue): the capability profile
  section dominates it. Shortening that section is a separate piece of work.
- The "before" numbers were taken on the old panel via a temporary `git stash` of the refactor,
  on the same dev server and viewport (1500×950).

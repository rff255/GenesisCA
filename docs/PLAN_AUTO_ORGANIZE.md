# Plan — "Organize" (auto-layout) on the graph context menu

**Scope: editor layer only.** A new pure module `src/modeler/vpl/autoLayout.ts` + wiring in
`GraphEditor.tsx` (+ a DEV hook, + one persisted view setting, + one Help row). **ZERO compiler
impact** — nothing under `src/modeler/vpl/compiler/` changes, no schema field, no worker message,
no emitted surface. Node **positions are not compiled**, so `check-compile-identity` must report
*"31 models, all surfaces unchanged"*, and that is a gate rather than an expectation.

Illustrated: [PLAN_AUTO_ORGANIZE.html](PLAN_AUTO_ORGANIZE.html).

> **There is no existing auto-layout facility in this repository.** `grep -rniE
> "dagre|elkjs|\belk\b|autoLayout|arrangeNodes|autoArrange"` over `src/`, `scripts/`,
> `package.json` returns **nothing**, and `package.json` carries no layout dependency
> (`@xyflow/react`, `geotiff`, `gifenc`, `react`, `react-dom`, `webm-muxer` + Tauri). The closest
> things that exist are **Align / Distribute** on the multi-selection menu
> ([GraphEditor.tsx:4693–4762](../src/modeler/vpl/GraphEditor.tsx)) and the **Ctrl-drag alignment
> guides** ([alignmentSnap.ts:44](../src/modeler/vpl/alignmentSnap.ts)) — both single-gesture
> nudges, neither a layout. `scripts/probe-graph-layout.mjs` is about the **bond-graph agent
> physics** layout (a force simulation over agents), not the node canvas, and shares no code.

---

## 1 · The gap

The user's request, verbatim:

> In order to better organize the graphs of the nodes canvas rules, the user sometimes spends quite
> some time to better distribute the nodes in a logical way that doesn't create overlapping of
> nodes, and minimize things like crossing links, improve alignment and so on. Investigate, plan,
> evaluate a risk map, and implement a context menu option to "Organize", similar to how "Blueprint
> Assist" works in Unreal. It might even have sub-context-menus to offer different styles, if you
> find it useful. The idea is to leave the manual organization as an option not a mandatory task for
> the users creating or improving their rule graphs.

Today every position in every shipped model is hand-placed. The largest single visible scope in the
library is **Amphiphile** (84 caNodes + 7 groups in one root scope); **Kelp War** carries 30 root
nodes across 2 groups and a comment plus **6 macro defs totalling 111 nodes**; **Accretor** has 71
caNodes + 5 reroutes + 3 comments at root plus an 8-node Overseer graph. Every one of those was
positioned by dragging.

---

## 2 · Investigation findings — what the editor does today

### 2.1 The context-menu system

`ContextMenuState` ([GraphEditor.tsx:807–824](../src/modeler/vpl/GraphEditor.tsx)) carries
`{x, y, flowX, flowY, target}` with six target shapes:

| target | opened by | menu block |
|---|---|---|
| `{type:'pane'}` | blank-canvas RMB, Spacebar quick-add, RMB in a group BODY | [:6350](../src/modeler/vpl/GraphEditor.tsx) |
| `{type:'node', nodeId, nodeType, isMacro, isGroup}` | RMB on a node outside the selection | [:6388](../src/modeler/vpl/GraphEditor.tsx) (caNode/reroute) · [:6536](../src/modeler/vpl/GraphEditor.tsx) (group) |
| `{type:'selection', nodeIds}` | RMB with ≥2 selected | [:6544](../src/modeler/vpl/GraphEditor.tsx) |
| `{type:'connection-drop', origin}` | wire released on empty canvas | — |
| `{type:'link-splice', origin, edgeId}` | 550 ms press-and-hold on a wire | — |
| `{type:'model-element-drop', element, snapToPort}` | panel element dropped on canvas | — |

`openContextMenu` ([:2832–2880](../src/modeler/vpl/GraphEditor.tsx)) resolves which one:
`nodeId && selection≥2 && nodeId ∈ selection` ⇒ `selection`; `nodeId` alone ⇒ `node`;
no `nodeId` && selection≥2 ⇒ `selection`; else `pane` ([:2847–2868](../src/modeler/vpl/GraphEditor.tsx)).
`x`/`y` are `.react-flow`-relative; `flowX`/`flowY` come from `rf.screenToFlowPosition`.

**The hover-submenu pattern is established three times**: `Align ›`
([:6584](../src/modeler/vpl/GraphEditor.tsx)), `Distribute ›`
([:6600](../src/modeler/vpl/GraphEditor.tsx)) and `Morph into ›`
([:6467](../src/modeler/vpl/GraphEditor.tsx)). Markup is
`<div className={styles.contextSubmenuTrigger}><button className={styles.contextItem}>Label<span>›</span></button><div className={styles.contextSubmenu}>…items…</div></div>`,
CSS-driven (`.contextSubmenuTrigger:hover > .contextSubmenu { display:block }`,
[GraphEditor.module.css:103–137](../src/modeler/vpl/GraphEditor.module.css)) with edge-flip via
`[data-submenu-left]` / `[data-submenu-up]`. **The trigger button itself has no `onClick`** in any
of the three — it is a pure hover affordance; the leaves do the work.

### 2.2 How positions are mutated, and the four disciplines around it

- **Mutation**: `setNodes(nds => nds.map(n => ({...n, position})))` — Align
  ([:4716–4725](../src/modeler/vpl/GraphEditor.tsx)) and Distribute
  ([:4754–4759](../src/modeler/vpl/GraphEditor.tsx)) are the model to copy: spread the node so
  `selected` / `data` / `measured` survive, change only `position`.
- **Undo**: `pushCurrentSnapshot()` ([:1784–1786](../src/modeler/vpl/GraphEditor.tsx)) →
  `pushSnapshot(toGraphNodes(nodesRef.current), toGraphEdges(edgesRef.current))`. **Called BEFORE
  the mutation, never inside the `setNodes` updater** (an updater runs as render work; inside it the
  snapshot would already be the post-state). Stack depth 50
  ([graphHistory.ts:8](../src/modeler/vpl/graphHistory.ts)); `clearHistory()` on every scope /
  graph swap ([:2137](../src/modeler/vpl/GraphEditor.tsx)).
- **Write-back**: `scheduleSync()` ([:1570–1589](../src/modeler/vpl/GraphEditor.tsx)) — debounced
  100 ms (400 ms while a pointer is held in Live). Root scope routes to
  `setGraph` / `setAgentGraph` / `setOverseerGraph` by `activeGraphRef`; a macro scope routes to
  `updateMacro(scopeId, {nodes, edges})`.
- **Grid**: `snapToGrid={snapEnabled} snapGrid={[20,20]}`
  ([:6119–6120](../src/modeler/vpl/GraphEditor.tsx)) — React Flow rounds *drag* positions only. The
  group-drag intercept re-implements the same rounding for members
  (`Math.round(totalDx/20)*20`, [:2686–2689](../src/modeler/vpl/GraphEditor.tsx)). `snapEnabled`
  seeds from `snapEnabledGlobal`, default **true**, persisted under
  `genesisca_graph_view_settings` ([graphState.ts:184, 227](../src/modeler/vpl/graphState.ts)).
  **A programmatic `setNodes` is NOT snapped by React Flow** — Align/Distribute today write raw
  floats (`centerH` divides by `sel.length`).

### 2.3 Node geometry and the data actually available

`nodeSize(n)` ([:710–727](../src/modeler/vpl/GraphEditor.tsx)) is the ONE existing size resolver:

```
w = measured.width  ?? width  ?? (group|comment ? style.width  ?? 200 : reroute ? 16 : 200)
h = measured.height ?? height ?? (group ? style.height ?? 200
                                 : comment ? style.height ?? 80
                                 : reroute ? 16
                                 : isCollapsed ? 32 : 100)
```

`nodeCenter(n)` ([:729–732](../src/modeler/vpl/GraphEditor.tsx)) is `position + size/2`.
`toGraphNodes` ([:675–694](../src/modeler/vpl/GraphEditor.tsx)) persists `measured.width/height`
into `data.width/height` for groups and comments only. **Positions are absolute for every node
type** — groups deliberately carry no React Flow `parentId`; `toRFNodes` actively scrubs a stray
`data.parentId` ([:628–638](../src/modeler/vpl/GraphEditor.tsx)).

React Flow v12 populates `measured` after layout; `getInternalNode(id).measured` is the ground truth
the trace-focus code uses ([:1692–1695](../src/modeler/vpl/GraphEditor.tsx)) and it is explicitly
*"only there once the element has laid out"* — which is why the mount race exists (see §8, risk R4).

### 2.4 Ports: flow vs value, and the vertical offsets

`handleId(port) = \`${kind}_${category}_${portId}\`` ([types.ts:281](../src/modeler/vpl/types.ts));
`parseHandleId` ([types.ts:286](../src/modeler/vpl/types.ts)) inverts it, so **a wire's category is
readable straight off the handle id** — no node lookup needed. `PortCategory = 'value' | 'flow'`
([types.ts:24](../src/modeler/vpl/types.ts)).

Canonical flow port ids (verified in the node defs):

| role | ids | evidence |
|---|---|---|
| flow IN | `do` (most), `check` (conditional / switch) | [StopEventNode.ts:14](../src/modeler/vpl/nodes/StopEventNode.ts), [ConditionalNode.ts:10](../src/modeler/vpl/nodes/ConditionalNode.ts), [SwitchNode.ts:10](../src/modeler/vpl/nodes/SwitchNode.ts), [LoopNode.ts:10](../src/modeler/vpl/nodes/LoopNode.ts) |
| flow OUT, pass-through | `next` (NEXT on actions, DONE on control nodes) | [ConditionalNode.ts:15](../src/modeler/vpl/nodes/ConditionalNode.ts), [LoopNode.ts:18](../src/modeler/vpl/nodes/LoopNode.ts), [SwitchNode.ts:15](../src/modeler/vpl/nodes/SwitchNode.ts) |
| flow OUT, branch | `then` / `else` / `body` / `default` / `case_N` / `first` / `then_N` | [ConditionalNode.ts:16–17](../src/modeler/vpl/nodes/ConditionalNode.ts), [LoopNode.ts:19](../src/modeler/vpl/nodes/LoopNode.ts), [SwitchNode.ts:16](../src/modeler/vpl/nodes/SwitchNode.ts), [SequenceNode.ts:10–12](../src/modeler/vpl/nodes/SequenceNode.ts), [effectivePorts.ts:47–80](../src/modeler/vpl/effectivePorts.ts) |
| ROOT flow OUT | `do` as an **output** | [StepNode.ts:10](../src/modeler/vpl/nodes/StepNode.ts), [OutputMappingNode.ts:10](../src/modeler/vpl/nodes/OutputMappingNode.ts), [InitEventNode.ts:26](../src/modeler/vpl/nodes/InitEventNode.ts), [BehaviourStepNode.ts:36](../src/modeler/vpl/nodes/BehaviourStepNode.ts), [ExperimentNode.ts:15](../src/modeler/vpl/nodes/ExperimentNode.ts) |

**Pure value nodes have no flow port at all** (arithmetic, Get Cell Attribute, Compare, the formula
nodes, …). That is exactly the distinction Blueprint Assist's `ParameterStyle` is about.

**Vertical layout on a node** ([CaNode.tsx:1571–1598](../src/modeler/vpl/CaNode.tsx)):

```
mainFlowIn  = first flow INPUT                       → rendered INSIDE .header at top:50%
mainFlowOut = 'next', else first flow OUTPUT         → rendered INSIDE .header at top:50%
bodyInputPorts / bodyOutputPorts = the rest
USER_LABEL_HEIGHT = 21     (a rename adds a .userLabel strip above the header)
PORT_TOP_BASE     = 30 + (userLabel ? 21 : 0)
portSpacing       = 22
body port i  →  style={{ top: `${PORT_TOP_BASE + i*portSpacing}px` }}
```

([:4804–4808](../src/modeler/vpl/CaNode.tsx) inputs, [:4922–4924](../src/modeler/vpl/CaNode.tsx)
outputs, [:2005–2039](../src/modeler/vpl/CaNode.tsx) the header pair.) React Flow's own handle CSS
centres on `top`, so **`top` is the handle CENTRE, not its top edge** — the number above is directly
usable as an offset. A **collapsed** node fans its connected handles at 11 px around the centre
(`spreadTop`, [:1958–1972](../src/modeler/vpl/CaNode.tsx)) and unconnected ones stay at 50 %.

The **effective** port list (after dynamic adds and `hiddenPorts` drops) is
`getEffectivePorts(nodeType, config, model)`
([effectivePorts.ts:35–175](../src/modeler/vpl/effectivePorts.ts)) — the file whose header says it
"MUST stay in sync" with CaNode's inline render logic. **Any port-offset maths MUST go through it**,
or Switch / Sequence / the formula nodes / multi-attr slots / Form Bond / lookup tables / vector
attributes get the wrong row.

### 2.5 Roots, scopes, graphs

- `MOVE_SCOPE_EXCLUDED_TYPES` ([macroMoveScope.ts:90–93](../src/modeler/vpl/macroMoveScope.ts)) =
  `macroInput, macroOutput, step, initEvent, gridInit, behaviourStep, divisionEvent, agentInit,
  experiment` — the macro boundary plus the **singleton event roots**.
- The full `category: 'event'` set also includes `inputColor`, `outputMapping`,
  `agentInputMapping`, `agentOutputMapping`, `agentPeriodicEvent`, `gridPeriodicEvent`,
  `periodicStep` and `stopEvent`. **`stopEvent` is NOT a root** — it has a flow *input*
  ([StopEventNode.ts:14](../src/modeler/vpl/nodes/StopEventNode.ts)).
- The editor shows **exactly one scope at a time**: root graph of the active sub-tab, or a macro
  def's inner `nodes`/`edges` ([:2103–2144](../src/modeler/vpl/GraphEditor.tsx)). Three root graphs:
  `cells` / `agents` / `overseer` ([:842–850](../src/modeler/vpl/GraphEditor.tsx)).
- **A macro def's node array is shared by every instance** — laying out a def changes what every
  instance shows *when entered*; at root an instance is one closed node, so nothing moves there.

### 2.6 Groups, comments, reroutes — how they really work

- **Groups have NO `parentId`.** Membership is **purely geometric and computed only at
  `onNodeDragStart`** ([:2756–2795](../src/modeler/vpl/GraphEditor.tsx)): every node whose **centre
  is strictly inside the group's rect** is snapshotted, then translated per-tick by
  `member.startPos + totalDelta` inside `handleNodesChange`
  ([:2669–2707](../src/modeler/vpl/GraphEditor.tsx)). Nested groups are collected by the same test,
  no recursion.
  **⚠ A programmatic `setNodes` that moves a group does NOT move its members.** Today's Align /
  Distribute already have this bug for a selected group; the layout must not inherit it.
  Group default size 300×200 ([:646](../src/modeler/vpl/GraphEditor.tsx)); `zIndex: -1`;
  `dragHandle` restricted to the header strip. (`resizeGroupsToFit`, still named in
  `modeler-ui.md`, **no longer exists** in the source — doc drift worth fixing in the same pass.)
- **Comments** are `type:'commentNode'`, `data:{text,width,height}`, default 200×80
  ([:655](../src/modeler/vpl/GraphEditor.tsx)), **no edges at all**.
- **Reroutes** are `type:'rerouteNode'`, ~16 px, one inbound edge (enforced,
  [:2302–2308](../src/modeler/vpl/GraphEditor.tsx)) and any number of outbound; the compiler removes
  them in `collapseReroutes`
  ([compiler/rerouteCollapse.ts](../src/modeler/vpl/compiler/rerouteCollapse.ts)) with a memoised,
  cycle-guarded transitive walk. They are ordinary draggable nodes.

### 2.7 The graph is a DAG — enforced

`isValidConnection`'s last gate is a **BFS cycle check over the whole edge set**, flow and value
together ([:2427–2441](../src/modeler/vpl/GraphEditor.tsx)). So every graph built through the UI is
acyclic. A hand-edited `.gcaproj` could still carry a cycle, so the layout must be defensive but
never needs a good answer for one.

### 2.8 Live mode + Rule Trace

- The trace highlighter writes a **`data-trace` ATTRIBUTE by `data-id`** onto
  `.react-flow__node` / `.react-flow__edge`
  ([rule-trace.md § The `data-trace` ATTRIBUTE contract](areas/rule-trace.md)). A position change is
  a `transform` update on an existing element, **not a remount**, and React never strips an unknown
  attribute — so a mass re-position **does not disturb the lit path**. The bounded-rAF re-apply
  exists for *mount* races (entering a macro), which Organize does not cause.
- Positions are UI-only. The run is untouched. **But** `scheduleSync` in Live writes the graph back
  to `ModelContext`, which is not deep-equal after a move, so `SimulatorView`'s
  `useEffect([model, compileModel])` fires a **soft recompile** — exactly as one node drag does
  today. Pre-existing behaviour, one occurrence per Organize.
- `overlayOwnsKeyboard()` probes for `[role="dialog"] / [role="menu"]`; the context menu carries
  `role="menu"`, so any new keyboard binding must stand down while it is open (the existing
  handlers already do).

### 2.9 Existing keyboard bindings (collision check)

| where | keys |
|---|---|
| `GraphEditor` [:4551–4571](../src/modeler/vpl/GraphEditor.tsx) | `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`, `Ctrl+C/V/X`, `Ctrl+D` |
| `ModelerView` [:329–383](../src/modeler/ModelerView.tsx) | `Ctrl+F`, bare `F`, `Space`, `Escape` |
| overlay table [KeyboardShortcutsOverlay.tsx:22–36](../src/components/KeyboardShortcutsOverlay.tsx) | + `Ctrl+S`, `?`, `Ctrl+drag` |

**Bare `O` is free**, and bare-letter shortcuts already have a precedent (`F`) with the right guard
shape (`INPUT/TEXTAREA/SELECT/isContentEditable` + `overlayOwnsKeyboard()`).

---

## 3 · The proposed UX

### 3.1 Where the entry goes

| menu | entry | what it organizes | anchor |
|---|---|---|---|
| **pane** ([:6350](../src/modeler/vpl/GraphEditor.tsx)) | `Organize ›` — placed after `Import Macro…`, **above** the `<hr>` that separates the actions from the quick-add search | the **whole visible scope** | the scope's current bbox top-left |
| **selection** ([:6544](../src/modeler/vpl/GraphEditor.tsx)) | `Organize Selection ›` — in the Align/Distribute block, immediately **above** `Align ›` | the selected nodes only; edges to unselected nodes are ignored for layering but the selection's roots are "nodes with no *selected* flow predecessor" | the **selection's** bbox top-left |
| **single node** | — **deferred to v2** (§9) | | |
| **group node** ([:6536](../src/modeler/vpl/GraphEditor.tsx)) | — not offered; RMB in a group's BODY already opens the *pane* menu ([:2894–2899](../src/modeler/vpl/GraphEditor.tsx)) | | |

Both are `.contextSubmenuTrigger` hover submenus with **no `onClick` on the trigger** — identical in
shape to `Align ›` / `Distribute ›` / `Morph into ›`, so nothing new has to be learned and the
"an enabled control must do something" doctrine is satisfied by the leaves.

### 3.2 The styles submenu (v1 = three leaves)

| leaf | what it does | padding (x, y) |
|---|---|---|
| **Tidy** | Keeps the user's column structure. Clusters the existing x-positions into columns, aligns each column, straightens flow chains onto their predecessor's handle row, removes overlaps, snaps to grid. **The non-destructive one.** | derived from the existing columns; `gapY` 30 |
| **Compact** | Full re-layout. Blueprint Assist's default feel. | 60 × 30 |
| **Expanded** | Full re-layout, roomy — readable at low zoom, good for screenshots and teaching models. | 120 × 60 |

Each leaf carries a `title` saying exactly that (the project's "every explanation is a `title`" rule).

**What is deliberately NOT a style, and why:**

- **`ParameterStyle=LeftSide` is the only correct behaviour here, so it is not a choice.** GenesisCA
  draws flow left→right (`.handleFlow` triangles point right, both sides) and every value node feeds
  an input on a consumer's LEFT edge. "Parameters inline / ahead" would mean drawing a value node to
  the right of the node that consumes it — a backwards wire on every parameter. Offering it would be
  a control that makes the graph worse.
- **`bCreateKnotNodes` (auto-inserting reroutes on long/backward wires) is deferred** — it MUTATES
  the graph, not just positions, which means edge ids, the `.gcaproj` diff, the compiler's
  `collapseReroutes` and a much larger undo story. v1 **preserves** existing reroutes (§4.9) and
  creates none.
- `ExecutionWiringStyle` / `ParameterWiringStyle` (BA's `AlwaysMerge`) are about *inserting knots to
  merge parallel wires* — same reason, same deferral.
- `bSnapToGrid` is not a style: the layout follows the canvas's own snap toggle (§4.12).

### 3.3 Default action, keyboard, and persistence

- The **last style used** is persisted alongside the other canvas view toggles in
  `graphState.ts`'s `genesisca_graph_view_settings` block
  ([graphState.ts:184–231](../src/modeler/vpl/graphState.ts)) as
  `organizeStyle: 'tidy' | 'compact' | 'expanded'` (default `'compact'`). This is the documented
  home for canvas view settings — *"New view settings should join this block, not plain
  `useState(default)`"*.
- **Shortcut: bare `O`** — "Organize" — registered in `GraphEditor`'s existing keydown effect
  ([:4551](../src/modeler/vpl/GraphEditor.tsx)) with that handler's field guard, plus
  `overlayOwnsKeyboard()` and, in Live, the `getLiveFocus() !== 'graph'` stand-down the clipboard
  arm already uses ([:4563](../src/modeler/vpl/GraphEditor.tsx)). It applies the persisted style to
  the **selection if ≥2 nodes are selected, otherwise the whole scope** — the same rule the two menu
  entries express. New rows in `KeyboardShortcutsOverlay` (Modeler group) and HelpView's shortcut
  table.
- **No toolbar / Palette entry.** The canvas view-toggle cluster (grid / snap / port labels / ⛶) is
  for *view state*, not for graph edits; Organize is an edit and belongs with the other edits.

### 3.4 Doctrine: hide vs grey

| situation | disposition | reason shown |
|---|---|---|
| scope has **< 2** layout-eligible nodes | **hidden** (pane menu) | nothing to organize; a greyed row would be pure clutter |
| selection has **< 2** nodes | structurally unreachable — the `selection` target only exists at ≥2 ([:2849](../src/modeler/vpl/GraphEditor.tsx)) | — |
| a node drag or a connection is **in flight** | the menu cannot be open then | — |
| everything else | enabled | — |

No new greyed rows. Organize is never structurally impossible on a populated scope.

### 3.5 Undo, and no confirmation

**ONE `pushCurrentSnapshot()` before ONE `setNodes` + ONE `scheduleSync()`.** A single `Ctrl+Z`
restores every previous position (and, in P3, every group rect and comment rect). **No confirmation
dialog** — the project's idiom for a reversible bulk edit is undo, not a prompt (`Dissolve Reroutes
(n)`, `Create Macro`, `Morph into`, Align / Distribute all commit straight away), and a prompt on
every Organize would make the feature feel dangerous when it is not. The *destructive-feeling* case
is covered instead by **Tidy**, which is the style that respects an existing arrangement.

---

## 4 · The algorithm

All of it lives in **`src/modeler/vpl/autoLayout.ts`** — DOM-free, React-free, no imports from
`GraphEditor.tsx`, exactly like `alignmentSnap.ts` and `macroMoveScope.ts`. One entry point:

```ts
export interface LayoutNodeIn {
  id: string;
  kind: 'node' | 'reroute' | 'comment' | 'group';
  x: number; y: number; w: number; h: number;
  /** handleId → y offset from the node's TOP, for every port that carries an edge */
  portY: Readonly<Record<string, number>>;
  /** a declared `category: 'event'` type with no flow input — used only for root ORDERING */
  rootRank?: number;
}
export interface LayoutEdgeIn {
  id: string; source: string; sourceHandle: string; target: string; targetHandle: string;
}
export interface LayoutOptions {
  style: 'tidy' | 'compact' | 'expanded';
  gapX: number; gapY: number;
  grid: number;                 // 0 = no rounding (snap toggle off)
  anchor: { x: number; y: number };
  groupPad: number; commentPad: number;
}
export interface LayoutResult {
  /** id → new absolute position; only entries that MOVED are required to be present, but the
   *  implementation returns all of them so the harness can assert on the full set */
  positions: Record<string, { x: number; y: number }>;
  /** P3: group / comment rects that must be written back through data.width/height */
  boxes: Record<string, { w: number; h: number }>;
  stats: { columns: number; crossings: number; backEdges: number; components: number; ms: number };
}
export function computeAutoLayout(
  nodes: readonly LayoutNodeIn[],
  edges: readonly LayoutEdgeIn[],
  opts: LayoutOptions,
): LayoutResult;
```

`GraphEditor` builds the input from `nodesRef.current` / `edgesRef.current` (never a render closure
— the same source `handleNodesChange` reads), using `nodeSize` for `w`/`h` and
`getEffectivePorts` + the CaNode constants for `portY` (§5).

### 4.1 Partition and reroute transparency

`comment` and `group` nodes leave the layout graph (steps 4.10–4.11 handle them). A **reroute is
transparent**: every edge whose source is a reroute is rewritten to the first non-reroute source
upstream (memoised + cycle-guarded — mirror `collapseReroutes`), and every edge *into* a reroute is
dropped. Reroutes get positions in step 4.9, after their endpoints are final.

### 4.2 Edge classification

`category = parseHandleId(sourceHandle).category` — the editor guarantees both ends match
([:2294](../src/modeler/vpl/GraphEditor.tsx)). FLOW edges are the spine; VALUE edges are parameter
dependencies.

### 4.3 Acyclicity (defensive)

One iterative DFS over the union graph marks every edge that closes a cycle as a **back edge**; back
edges are excluded from layering, from the barycentre sweeps and from straightening (they are still
drawn, just not honoured). `stats.backEdges` reports how many. On a UI-built graph this is always 0.

### 4.4 Roots

`roots` = nodes with **no incoming FLOW edge**. Ordering (fully deterministic):

1. `rootRank` ascending — a fixed priority over the declared event types:
   `step, initEvent, gridInit, behaviourStep, divisionEvent, agentInit, experiment,
    inputColor, agentInputMapping, outputMapping, agentOutputMapping,
    periodicStep, gridPeriodicEvent, agentPeriodicEvent`, everything else last;
2. then previous `y` ascending (the user's own vertical intent, kept where it is free);
3. then `id` (the final tie-break — no Map-order dependence anywhere).

### 4.5 Columns — longest-path layering, flow first, parameters pulled left

```
PASS 1 (flow, forward):   col(n) = 0 for a root
                          col(n) = max over flow-preds p of col(p) + 1
PASS 2 (value, backward): col(v) = min over consumers c of col(c) − 1     (recursive, memoised)
```

- Pass 1 is a fixed point over the flow DAG only; **value edges never push a flow node right.**
  That is the inverse of Blueprint Assist's `bExpandNodesAheadOfParameters`: instead of moving the
  exec node to make room for its parameters, we grow the parameter chain leftward, which keeps the
  exec spine at the canonical column it earned.
- Pass 2 recurses: a value node feeding only other value nodes takes `min(consumer) − 1` of them in
  turn. A value node feeding **several** consumers sits left of its **leftmost** consumer — so a
  shared `Get Cell Attribute` lands once, on the left, and fans out rightward.
- A value node with no consumers at all (an orphan the user parked on the canvas) joins its
  component at `min(col) − 1` if it has producers, else column 0.
- Columns may go negative; normalise by subtracting `min(col)`.

### 4.6 Ordering within a column — crossing reduction

- **Seed**: previous `y` ascending, ties by `id`.
- **4 barycentre sweeps** (down, up, down, up). A node's barycentre is the mean *row index* of its
  neighbours in the adjacent column, with **FLOW edges weighted ×4** — a flow chain should come out
  straight; a value wire may bend. Sorts are **stable**, so equal barycentres keep the previous
  order.
- **Flow-chain pin**: a node reached through `next` / `then` / `first` / `body` from its flow
  predecessor prefers the predecessor's row band; the pin is applied as a barycentre bias, never as
  a hard constraint (a hard pin deadlocks on fan-out).
- Count crossings after each sweep (the standard accumulator count, O(E log V)); **keep the best
  ordering seen**, with the seed as the tie-winner. Fixed sweep count, no randomness ⇒ deterministic
  and idempotent.

### 4.7 Coordinates

- **x**: `x[c] = x[c−1] + max(width of column c−1) + gapX`, starting at `anchor.x`.
- **y**: stack in order, `y[i] = y[i−1] + h[i−1] + gapY`, starting at `anchor.y`.
- **Straightening pass** (the quality step, 2 iterations, left→right then right→left):
  for each node compute a **desired y** —
  - a node with a flow predecessor: the y that puts its `mainFlowIn` **handle** at the same absolute
    y as the predecessor's **taken flow-out handle** (`portY` lookups on both sides);
  - a pure value node: the mean of its consumers' input-handle absolute y, minus its own output
    handle offset;
  - otherwise: leave it.

  Then resolve each column with the **priority method**: process nodes by descending priority
  (flow-chain members first, then degree), move each toward its desired y, then run a single
  monotone "push down, then push up" separation that restores the `gapY` minimum **without
  reordering**. Ordering is step 4.6's answer and this pass must never revisit it.

### 4.8 Collision resolution

Column x-spacing (≥ max width + `gapX`) makes cross-column overlap impossible; the separation pass
makes within-column overlap impossible. A final defensive sweep sorts each column by y and re-applies
the minimum separation — O(n log n), and it is what the harness's *no two boxes overlap* assertion
actually leans on.

### 4.9 Reroutes

Each reroute is placed on the straight segment between its resolved source handle and its **first**
consumer's target handle, at the parameter `t` it occupied on the OLD segment (its old position
projected onto the old line), clamped to `[0.15, 0.85]`; degenerate old geometry ⇒ `t = 0.5`. A
chain of reroutes on one wire distributes over that range in order. This preserves a deliberate bend
without spending a whole column on a 16 px dot.

### 4.10 Groups — opaque super-nodes (decision **G1**)

**A group is laid out as a unit and the layout treats it as one big node.** Concretely, before
§4.1:

1. Each **top-level** group (one whose centre is not inside another group's rect) is identified, and
   its members are the nodes whose **centre is strictly inside its rect** — the *same predicate as
   `onNodeDragStart`*, extracted into ONE shared exported helper so the two can never drift.
   Nesting recurses.
2. The induced sub-graph (members + edges with both ends inside) is laid out by a **recursive call**.
3. The group contracts to a **super-node** whose size is the inner result's bbox + `2×groupPad` +
   the header strip, and whose edges are the union of its members' external edges (deduped).
4. After the outer layout places the super-node, the inner result is translated into it and the
   group's own `position` + `data.width/height` are emitted.

**Why opaque rather than "lay everything out flat and re-fit the boxes afterwards":** a group means
*"these nodes belong together"*. A flat layout would scatter a group's members across columns and the
re-fitted rect would then swallow unrelated nodes — silently changing what the group *contains*,
because membership is geometric. G1 makes the group's meaning a layout constraint, which is the only
way it survives. Cost: a group with edges in both directions to the outside can create a
super-node-level cycle; §4.3's back-edge removal handles it.

### 4.11 Comments — translate and wrap

A comment has no edges, so it is not a layout constraint. For each comment: take the set of nodes
whose centre was inside its OLD rect.
- non-empty ⇒ new rect = bbox(their NEW positions) + `commentPad` on each side;
- empty ⇒ translate by the global anchor delta (it keeps its relation to the canvas).

Sizes are written back through the documented NodeResizer persistence triple (`style` seed →
`data.width/height` → `toGraphNodes`), i.e. by `updateNodeData` in the same `setNodes` pass.

### 4.12 Components, anchor, grid

- Nodes not reachable from any root form their own **components**. Each is laid out independently
  and the components are **stacked vertically** at the anchor x, separated by `2×gapY`, ordered by
  (has a declared root, then previous min-y, then id).
- **Anchor**: translate the whole result so its bbox top-left equals the ORIGINAL bbox top-left of
  the laid-out set. The canvas does not jump and **`fitView` is deliberately NOT called** — a
  `Ctrl+Z` has to land on the same screen the Organize did.
- **Grid**: round every final position to `opts.grid` **only when `snapEnabledGlobal` is true**
  (matching drag behaviour), *after* the anchor translation, and round the anchor itself.
  ⚠ Rounding moves a box by at most `grid/2` = 10 px, so with `gapY ≥ 30` two separated boxes stay
  separated by ≥ 10 px — **rounding can never create an overlap**, which is why Compact's `gapY` is
  30 (also Blueprint Assist's `Padding=(60,30)`) and not smaller. Straightened band y values are
  quantised **before** assignment so a whole chain rounds identically and stays aligned.

### 4.13 Tidy

Tidy skips §4.5 and §4.6 entirely:
- columns are **derived from the current x**: nodes whose x-intervals overlap by more than 50 % of
  the narrower node join one cluster; clusters sort by mean x;
- row order is the current y;
- then §4.7 (straightening only — each column's x is its members' mean x, quantised), §4.8, §4.9,
  §4.11, §4.12.

So Tidy = *"align my columns, straighten my flow chains, remove my overlaps, snap to grid"*, and it
is the style for a graph the user has already arranged.

### 4.14 Dimensions and graph kinds

- **2D / 3D**: the rule graph's node and edge structure is identical in a 2D and a 3D model — the
  lattice dimension reaches the *compilers* (`CompileContext.is3d`, the NI codec), never the canvas.
  The layout is dimension-agnostic by construction. Verified all the same (§7) because that is the
  standing rule, not because a difference is expected.
- **Cells / Agents / Overseer**: one algorithm; only §4.4's root set differs (`step` & friends /
  `behaviourStep` & friends / `experiment`).

### 4.15 Complexity

Layering O(V+E) · barycentre 4×O(V log V + E) · crossing count O(E log V) per sweep · straightening
2×O(V+E) · separation O(V log V). Budget: **< 5 ms at 300 nodes, < 16 ms at 1000** on the harness
machine, asserted as a soft check. The largest shipped scope is 91 nodes.

---

## 5 · Handle geometry — how the implementer gets a port's y offset

**Primary (works pre-render, and is the one to ship):** recompute CaNode's own formula from the
effective port list.

```ts
// ports = getEffectivePorts(nodeType, config, model)
const mainFlowIn  = ports.inputs.find(p => p.category === 'flow') ?? null;
const mainFlowOut = ports.outputs.find(p => p.id === 'next')
                 ?? ports.outputs.find(p => p.category === 'flow') ?? null;
const bodyIn  = mainFlowIn  ? ports.inputs.filter(p => p !== mainFlowIn)   : ports.inputs;
const bodyOut = mainFlowOut ? ports.outputs.filter(p => p !== mainFlowOut) : ports.outputs;

const labelH  = node.data.label ? 21 : 0;          // USER_LABEL_HEIGHT
const headerY = labelH + 15;                        // .header's vertical centre
const base    = 30 + labelH;                        // PORT_TOP_BASE
const SPACING = 22;                                 // portSpacing

portY(port) = (port === mainFlowIn || port === mainFlowOut)
  ? headerY
  : base + indexIn(bodyIn | bodyOut) * SPACING;
```

Every constant is mirrored from [CaNode.tsx:1594–1598](../src/modeler/vpl/CaNode.tsx) and
[:2026](../src/modeler/vpl/CaNode.tsx) (`style={{top:'50%'}}` inside `.header`). React Flow's handle
CSS centres on `top`, so these are handle **centres**. **Collapsed** node: every connected handle is
fanned at 11 px steps around the node centre (`spreadTop`,
[CaNode.tsx:1958–1972](../src/modeler/vpl/CaNode.tsx)) — mirror that branch; unconnected handles sit
at the centre.

**⚠ The constants must be exported from ONE place.** Move `USER_LABEL_HEIGHT` / `PORT_TOP_BASE`'s
base / `portSpacing` / the header-centre value into a tiny exported block in `CaNode.tsx` (or a new
`nodeGeometry.ts`) that CaNode itself consumes, so the layout cannot silently drift from what is
rendered — the `buildExtraSlotPorts` / `applyLookupAxisPorts` dual-consumption discipline. The
harness pins the equality (§7).

**Fallback / refinement (already in the codebase):** `getPortScreenCentre(nodeId, portId, kind,
category)` ([GraphEditor.tsx:564–577](../src/modeler/vpl/GraphEditor.tsx)) reads the real
`[data-handleid]` rect. It is DOM-only and needs the node mounted, so it is **not** the primary path
— but it is the right tool for the harness's *"the formula matches the DOM"* live check, and for a
future refinement pass. The precedent for "estimate then refine" is the panel-drag snap
(`estimateNewNodePortY` [:517–526](../src/modeler/vpl/GraphEditor.tsx) + `scheduleSnapRefinement`);
Organize does not need the refinement because a ±2 px handle error only perturbs straightening, which
is then quantised to the grid anyway.

---

## 6 · Wiring in `GraphEditor.tsx`

```ts
const organize = useCallback((scopeSel: 'scope' | 'selection', style: OrganizeStyle) => {
  const all = nodesRef.current;
  const ids = scopeSel === 'selection'
    ? new Set((contextMenu?.target as {nodeIds:string[]}).nodeIds)   // captured BEFORE the close
    : null;
  const subject = ids ? all.filter(n => ids.has(n.id)) : all;
  if (subject.filter(layoutEligible).length < 2) { setContextMenu(null); return; }

  const result = computeAutoLayout(buildLayoutNodes(subject), buildLayoutEdges(subject), {
    style, ...STYLE_PADDING[style],
    grid: snapEnabled ? 20 : 0,
    anchor: bboxTopLeft(subject),
    groupPad: 24, commentPad: 16,
  });

  pushCurrentSnapshot();                       // BEFORE the mutation, outside the updater
  setNodes(nds => nds.map(n => {
    const p = result.positions[n.id];
    const b = result.boxes[n.id];
    if (!p && !b) return n;
    return {
      ...n,                                    // selected / data / measured all survive
      position: p ?? n.position,
      ...(b ? { style: { ...n.style, width: b.w, height: b.h },
                data: { ...n.data, width: b.w, height: b.h } } : null),
    };
  }));
  scheduleSync();
  setContextMenu(null);
}, [contextMenu, snapEnabled, setNodes, scheduleSync, pushCurrentSnapshot]);
```

- ONE snapshot, ONE `setNodes`, ONE `scheduleSync` — the `spliceNodeIntoEdge` / `dissolveReroutes`
  discipline.
- **No `updateNodeInternals`**: positions do not change handle offsets. (A group/comment *resize*
  does change its own box but has no handles.)
- **No `fitView`** (§4.12).
- **DEV hook** `window.__organize(scopeSel, style)` next to `__dissolveNode` / `__morphNode` — React
  Flow ignores synthetic pointer events for selection, so a semantics test drives the same function
  the menu item calls (the documented escape hatch).

---

## 7 · Verification plan

### 7.1 The pure module + a Node harness — `scripts/verify-auto-layout.mjs`

House style: **assert VALUES, never "it compiled"; negative-control every claim; make every fixture
DISCRIMINATE.** Drives the SHIPPED `autoLayout.ts` bundled with esbuild into a temp dir and imported
(the `test-macro-expand.mjs` / `test-vector-attr.mjs` pattern).

**Section A — invariants on synthetic fixtures** (a straight chain; a conditional with two branches;
a shared value node with three consumers; a value chain 3 deep; a Switch with 4 cases; two
disconnected components; a collapsed node; a renamed node; a 300-node generated graph):

| # | assertion |
|---|---|
| A1 | **No two laid-out boxes overlap** (pairwise rect intersection = 0) |
| A2 | **Every non-back FLOW edge points right**: `x(target) > x(source)` |
| A3 | **Every VALUE producer is left of every consumer**: `x(source) + w < x(target)` |
| A4 | **Crossing count does not increase** vs the seed ordering, and strictly decreases on the hand-built crossing fixture |
| A5 | **Straightness**: on the straight-chain fixture every consecutive pair's `mainFlowIn` / `mainFlowOut` handle absolute y are equal (post-grid, exactly equal) |
| A6 | **Determinism**: 100 runs over shuffled input arrays produce byte-identical `positions` |
| A7 | **Idempotence**: `layout(layout(g)) === layout(g)` for every style and every fixture |
| A8 | **Anchor**: the result bbox top-left equals the input bbox top-left (± grid/2) |
| A9 | **Grid**: with `grid: 20` every coordinate is `x % 20 === 0`; with `grid: 0` none is forced |
| A10 | **Cycle safety**: a hand-built cyclic fixture terminates, reports `backEdges > 0`, and still satisfies A1 |
| A11 | **Components** are stacked, non-overlapping, and ordered root-first |
| A12 | **Budget**: 300 nodes < 5 ms, 1000 nodes < 16 ms (soft — reported, and fails only past 4× budget) |
| A13 | **Tidy preserves column membership**: every pair that shared a column before shares one after |
| A14 | **Groups (P3)**: every node inside a group's rect BEFORE is inside it AFTER (`pre ⊆ post`), and no node that was outside is inside |
| A15 | **Comments (P3)**: every node inside a comment's rect BEFORE is inside it AFTER |
| A16 | **Reroutes** land between their resolved endpoints (inside the segment's bbox), never in a column of their own |
| A17 | **Missing `measured`**: the same fixture with every `w`/`h` at the `nodeSize` fallbacks still satisfies A1–A3 |

**Section B — the port-geometry mirror.** The `portY` formula is asserted against the CaNode
constants read from source (anchored, function-scoped greps in the `verify-handle-remeasure.mjs`
tier-B style): `USER_LABEL_HEIGHT === 21`, `PORT_TOP_BASE === 30 + …`, `portSpacing === 22`, the
`mainFlowIn` / `mainFlowOut` derivation, and that the body index comes from
`getEffectivePorts` — driven on a real Switch config (`caseCount: 3`) and a real formula node
(`visibleCount: 4`) so a `hiddenPorts` / dynamic-port regression is caught.

**Section C — the library sweep.** For all 31 shipped `.gcaproj`, every scope (root cells / agents /
overseer + every macro def): run all three styles and assert A1, A2, A3, A6, A7. This is the check
that finds the shape nobody thought of.

**Negative controls (all by deliberate SOURCE MUTATION, each must make the suite FAIL):**

1. drop the separation pass → A1 fails;
2. make the value pass push *right* instead of left → A3 fails;
3. make the barycentre sort unstable (`Math.random()` tie-break) → A6 and A7 fail;
4. drop the flow ×4 weight → A4's strict-decrease fixture fails (it is chosen so the weight is
   load-bearing);
5. round before anchoring → A8 fails;
6. drop the back-edge exclusion → A10 hangs (the harness asserts a time bound, so it fails rather
   than spins).

### 7.2 Through the real UI (the standing rule: never conclude "works" from a direct call)

Real right-clicks, real submenu clicks, real loads, `0 console errors`, on:

| model | why it is in the list |
|---|---|
| **Game Of Life** (12 cell nodes + a 7-node macro def) | the smoke test, and the **macro def scope** — organize inside the def, leave, re-enter, confirm every instance shows it |
| **Amphiphile** (84 caNodes + **7 groups**, one root scope) | the biggest single scope + the group constraint (G1) |
| **Kelp War** (30 root nodes, 2 groups, 1 comment, **6 macro defs / 111 nodes**, reroutes inside the defs) | macros × groups × comments × reroutes together |
| **Accretor** (71 caNodes + **5 reroutes** + 3 comments, **3D**, + an 8-node **Overseer** graph) | reroutes, comments, the Overseer graph, and a 3D model |
| **Particle Life** (37 **agent** nodes) | the Agents sub-tab |
| **Life3D** (20 cell nodes, **3D**) | the 2D/3D dual-impact rule — a 3D model's rule graph must organize exactly like a 2D one |

Per model: Organize (each style) from the pane menu; Organize Selection on a box-selected subset;
**one `Ctrl+Z` restores every position** (assert node-for-node against a pre-capture); the viewport
does not jump; the graph still compiles on all three targets; and — for Kelp War and Particle Life —
do it **in Live with the simulation running**, confirming the trace's lit path survives the move and
the run keeps stepping.

### 7.3 Gates

- `node scripts/check-compile-identity.mjs --compare <baseline>` → **expected claim: 31 models, all
  surfaces unchanged.** Positions are not compiled; anything else is a bug in the wiring.
- `node scripts/verify-auto-layout.mjs` (+ its negative controls).
- `node scripts/verify-handle-remeasure.mjs` — the geometry constants it already pins are now
  load-bearing for two consumers.
- `npx tsc -p tsconfig.app.json --noEmit` and `npm run build`.

---

## 8 · Risk map

| # | risk | L | I | mitigation |
|---|---|---|---|---|
| **R1** | **Destroying a careful manual layout.** Organize is a bulk positional rewrite; a user who reaches for it on a graph they spent an hour arranging loses that arrangement. | High (it is the point) | Med | ONE undo step restores everything, and that is stated in the item `title`. **Tidy** exists precisely as the style that preserves the user's column structure. **No confirmation dialog** — the project's idiom for reversible bulk edits; a prompt would make a safe action feel unsafe. The trigger is a hover submenu with no click action, so a mis-click cannot fire it. |
| **R2** | **Group membership desync.** Membership is geometric and is only computed at `onNodeDragStart` ([:2756](../src/modeler/vpl/GraphEditor.tsx)); a programmatic move of a group leaves its contents behind, and a re-fitted rect can silently swallow unrelated nodes. Today's Align/Distribute already have the first half of this bug. | Certain if unhandled | **High** | Decision **G1** (§4.10): a group contracts to an opaque super-node, its members are laid out inside it and translated with it, and its rect is re-fitted around exactly them. The containment predicate is **extracted into ONE exported helper** shared with `onNodeDragStart`. Harness **A14** asserts `pre ⊆ post` and that no outsider is captured. |
| **R3** | **Comments orphaned** — an annotation ends up nowhere near what it annotates. | High | Med | §4.11 translate-and-wrap; harness **A15**. A comment that contained nothing follows the anchor delta. |
| **R4** | **Unmeasured nodes.** `measured` is populated only after layout; right after a scope switch / a fresh model load every caNode can fall back to 200×100 (the same root cause as the documented `getNodesInside` force-include bug, `modeler-ui.md` § *Modeler UX & node additions*). A layout on fallback sizes produces real overlaps. | Med | **High** | (a) `nodeSize`'s documented fallbacks are used, never `undefined`; (b) a **measurement gate** — if > 20 % of caNodes lack `measured`, defer one rAF and retry, bounded to 3 frames (the P4/P8 mount-race precedent), then proceed with fallbacks rather than refusing; (c) harness **A17** runs the whole suite with sizes absent. |
| **R5** | **Port-offset drift from `effectivePorts` / CaNode.** If `portY` is computed from `def.ports` instead of `getEffectivePorts`, Switch / Sequence / formula / multi-attr / Form Bond / lookup / vector nodes get the wrong row and straightening quietly misaligns. If the constants are duplicated they drift the next time CaNode's header changes. | Med | Med | §5: `getEffectivePorts` is mandatory; the four constants get **one exported definition** consumed by CaNode itself; harness **section B** pins the equality on a real Switch and a real formula node. |
| **R6** | **Idempotence / determinism loss** — unstable sorts, Map iteration order, float drift ⇒ Organize twice moves things, and the harness's own baseline rots. | Med | Med | Explicit tie-breakers at every sort (barycentre → previous order → id), stable sorts only, no `Math.random` / `Date.now`, `Math.round` at the end, band-y quantised before assignment. Harness **A6 + A7**; negative control 3. |
| **R7** | **Cycles / back edges** — a hand-edited `.gcaproj` (or a future feature that relaxes the validator) carries a cycle; naive longest-path recursion hangs the UI thread. | Low | High | §4.3 DFS back-edge set + memoised, cycle-guarded value recursion (the `collapseReroutes` / `producesArray` precedent). Harness **A10** with a time bound; negative control 6. |
| **R8** | **Giant graphs** — the layout runs on the UI thread; a slow one freezes the editor. | Low today (max shipped scope 91 nodes) | Med | §4.15 complexity + harness **A12**. The *models are WIP* rule applies: do not size the budget to today's library — the budget is 1000 nodes. |
| **R9** | **Live mode** — a mass re-position beside a running simulation. | Med | Low | Positions are UI-only: the worker is untouched and the run cannot be affected. The trace highlighter writes a `data-trace` **attribute by `data-id`**, and a position change is a `transform` update, not a remount, so the lit path survives (`rule-trace.md` § *The `data-trace` ATTRIBUTE contract*). The one real cost is **one soft recompile** from `scheduleSync`'s write-back — identical to dragging a single node today. Verified live on Kelp War + Particle Life (§7.2). |
| **R10** | **Macro def scope** — organizing inside a def changes the layout every *other* instance shows when entered. | Certain | Low | Positions live on the shared `MacroDef.nodes`; an instance at root is one closed node, so nothing visible moves there. Documented in `macros.md` + the Help chapter; no code guard (it is the correct behaviour — a def has one body). |
| **R11** | **Undo-history coupling** — a snapshot taken inside the `setNodes` updater would capture the post-state; `clearHistory()` on a scope swap means an Organize done just before a swap is unrecoverable. | Low | Med | `pushCurrentSnapshot()` outside and before the updater (§6). The scope-swap clear is pre-existing and documented (`macros.md` § *UNDO IS SCOPE-LOCAL*); Organize inherits it, it does not worsen it. |
| **R12** | **Selection lost / corrupted** — React Flow's `nodeLookup` drifts from the user nodes if a node object is replaced without care (the documented `getSelectionChanges(mutateItem=true)` trap). | Low | Med | The `setNodes` map **spreads the node** and changes only `position` (+ box for groups/comments), exactly as Align/Distribute do — `selected`, `measured` and `data` identity all survive; no select changes are emitted at all. |
| **R13** | **Viewport jump** — an Expanded layout grows past the visible area and the user loses their place. | Med | Low | Anchored at the previous bbox top-left; **no `fitView`** (§4.12), so the top-left of the graph stays where it was and `Ctrl+Z` lands on the same screen. |
| **R14** | **Reroutes stranded** — a dot left mid-canvas, or placed before its endpoints are final. | Med | Low | §4.9 runs **after** all other positions; `t` is preserved from the old segment. Harness **A16**. |
| **R15** | **The 20 px grid re-introduces overlap or breaks a straightened chain.** | Low | Low | §4.12: rounding moves a box ≤ 10 px and `gapY ≥ 30`, so separation survives; band y is quantised **before** assignment so a whole chain rounds identically. Harness **A5 asserts exact handle-y equality post-grid.** |
| **R16** | **Inconsistency with Align / Distribute**, which still use hardcoded `NODE_W = 200 / NODE_H = 100` ([:4695–4696](../src/modeler/vpl/GraphEditor.tsx)) and are therefore wrong for every real node. | Certain (pre-existing) | Low | Out of v1 scope, but recorded as a **follow-up**: port both onto the shared size resolver. Noting it here is what stops the next reader concluding the new module is the one that is wrong. |
| **R17** | **`parentId` assumption** — the layout assumes every position is absolute, which holds because groups deliberately have no `parentId` ([:628–638](../src/modeler/vpl/GraphEditor.tsx)). A future change to real RF parenting would silently break every coordinate. | Low | High | Documented as an invariant in `modeler-ui.md`; the harness's fixtures are all absolute, so a parenting change would surface as a live-UI mismatch immediately. |
| **R18** | **Overseer / Agents roots missed** — the root priority list is a hand-written table and a new event type added later would sort last, giving an odd but harmless order. | Med | Very low | The root *set* is structural (no incoming flow edge), so a missing table entry only affects **ordering**, never correctness. The table lives next to `MOVE_SCOPE_EXCLUDED_TYPES`'s sibling list and is covered by the library sweep (§7.1 C). |

**Top 5**: R2 (group desync) · R4 (unmeasured sizes) · R1 (destroying a layout) · R5 (port-offset
drift) · R3 (comments orphaned).

---

## 9 · Phasing

| phase | deliverable | files touched |
|---|---|---|
| **P1** | **The pure module + the harness.** `computeAutoLayout` for `node` + `reroute` kinds only (no groups, no comments), all three styles, components, back edges, anchor, grid. `verify-auto-layout.mjs` sections A + B + C with all six negative controls. Nothing is reachable from the UI yet. | **new** `src/modeler/vpl/autoLayout.ts` · **new** `scripts/verify-auto-layout.mjs` · `src/modeler/vpl/CaNode.tsx` (export the four geometry constants) — **3 files** |
| **P2** | **Context-menu wiring + undo + anchoring.** `Organize ›` on the pane menu and `Organize Selection ›` on the selection menu, the three leaves, the single snapshot / `setNodes` / `scheduleSync`, the measurement gate, the DEV hook, the persisted `organizeStyle`, the bare-`O` shortcut. Groups and comments are **translated by the anchor delta only** in this phase (honest, and never worse than leaving them). | `src/modeler/vpl/GraphEditor.tsx` · `src/modeler/vpl/graphState.ts` · `src/components/KeyboardShortcutsOverlay.tsx` — **3 files** |
| **P3** | **Groups + comments.** G1 super-node contraction (recursive, with the shared containment helper extracted from `onNodeDragStart`), comment translate-and-wrap, the box write-back through `data.width/height`. Harness A14–A15. | `src/modeler/vpl/autoLayout.ts` · `src/modeler/vpl/GraphEditor.tsx` · `scripts/verify-auto-layout.mjs` — **3 files** |
| **P4** | **Docs + Help.** | `docs/areas/modeler-ui.md` (a new *Auto-layout (Organize)* section + the `resizeGroupsToFit` drift fix) · `docs/areas/project-structure.md` (the `autoLayout.ts` line) · `docs/areas/testing-harnesses.md` (index row + count **68 → 69**) · `src/help/HelpView.tsx` (a paragraph in the Modeler chapter + an `O` row in the shortcuts table) · `README.md` **only if** a `## Features` summary sentence changes (it should not — this is an editor convenience, not a product-level capability) · **new** `docs/HANDOFF_AUTO_ORGANIZE.md` — **6 files** |

**Deferred, explicitly:**

- **Single-node `Organize ›`** — "organize the subtree rooted here" / "organize this connected
  component". Most rule graphs in the library are one root's tree, so the pane entry already covers
  it; revisit once there is a model where it does not.
- **Knot / reroute insertion** on long and backward wires (`bCreateKnotNodes`,
  `ExecutionWiringStyle=AlwaysMerge`) — a graph mutation, not a position change.
- **`bCenterBranches` / `NumRequiredBranches`** (centring a node between its branch targets) — a
  straightening refinement; measure whether the current rule already reads well first.
- **`FormatAllHorizontalAlignment` across components** beyond the vertical stack.
- Porting **Align / Distribute** onto the shared size resolver (R16).

---

## 10 · Why hand-rolled, not a dependency

| | dagre / elkjs | hand-rolled `autoLayout.ts` |
|---|---|---|
| bundle | dagre ≈ 90 KB min, elkjs ≈ 500 KB (+ a web-worker build) | ~600 lines, tree-shaken with the app |
| flow-vs-value semantics | none — every edge is one kind; "parameters left of their consumer" has to be faked by pre-contracting the value nodes or by post-processing | first-class (§4.5), which is the entire point of the feature |
| handle-level straightening | not expressible — both libraries lay out *node boxes*; GenesisCA's quality bar is "the exec pin of B is on the same pixel row as the exec pin of A", which needs per-port offsets | §4.7 |
| groups | dagre: no compound support; elk: yes, but its model has to be mirrored | §4.10, ~40 lines |
| determinism / idempotence | not guaranteed across versions | asserted (A6, A7) |
| project ethos | *"No external compilation toolchains"*, three hand-rolled compilers, 68 hand-rolled harnesses, one `@xyflow/react` runtime dep | fits |
| **offline / single-file** | elkjs's worker build fights the `vite-plugin-singlefile` viewer bundle and the strict CSP (the same argument that kept KaTeX out of the formula renderer) | no constraint |

A dependency is not forbidden, but here it would be **larger, less capable for this graph model, and
still need a post-pass for the two things that matter** (value-left placement and handle-row
straightening). **Recommendation: hand-rolled.** The pure-module + Node-harness shape is exactly what
the project's verification net is built for, and a DOM-free module of this size is cheap to
negative-control.

---

## 11 · Docs to update on delivery

1. **`docs/areas/modeler-ui.md`** — a new *Auto-layout (Organize)* section: the entry points and the
   doctrine call, the three styles and why `ParameterStyle` is not one, **decision G1**, the
   reroute/comment rules, the anchor + no-`fitView` rule, the grid-vs-`gapY` invariant, and the
   `portY` mirror warning (R5). Fix the stale `resizeGroupsToFit` bullet in the same pass.
2. **`docs/areas/project-structure.md`** — `autoLayout.ts` beside `alignmentSnap.ts` (line 77).
3. **`docs/areas/testing-harnesses.md`** — `verify-auto-layout.mjs` in the *Verifiers* table, and the
   harness count **68 → 69** (also in `CLAUDE.md` § *Verification gates*, which is the one place that
   number is repeated).
4. **`src/help/HelpView.tsx`** — a paragraph in the **Modeler** chapter and an `O` row in the
   shortcuts table.
5. **`src/components/KeyboardShortcutsOverlay.tsx`** — the Modeler group row.
6. **`README.md`** — only if a `## Features` sentence changes. It should not: the Features section is
   deliberately product-level and an editor convenience does not alter any of its one-to-three
   sentence summaries.
7. **`docs/HANDOFF_AUTO_ORGANIZE.md`** — the build narrative: measurements (before/after crossing
   counts and bbox areas on the six models of §7.2), the verification transcript, and the
   as-built deviations.
8. **`CLAUDE.md`** — **no new section and no new routing row.** The feature lives inside the graph
   editor, which `modeler-ui.md` already routes; adding a row would cost every future session for
   nothing (§ *Keeping this file small*).

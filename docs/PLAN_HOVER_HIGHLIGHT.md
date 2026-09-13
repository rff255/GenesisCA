# Plan — Hover highlight on the graph canvas (node · its wires · its neighbours)

> **Status: DELIVERED, 2026-09-13, branch `hover-highlight`.** **P1** (the thirds, the reroute walk, the
> colour lift, the hysteresis, the editor wiring, the CSS, the harness) shipped as commit `f3ecf0e`;
> **P2** (I1 port-precise + I2 wire hover, H7/H8, the docs sweep, the Help bullet) is on the same branch.
> **P3** (I3 the Alt transitive cone, I7 the Explorer cross-highlight, a view-settings toggle) is NOT
> built — decisions D5 / D6 stand as recorded in §9.
>
> Read §*As built — deviations* at the end before trusting any code sketch in this plan; the reference
> documentation is [`areas/modeler-ui.md`](areas/modeler-ui.md) § *Hover highlight*.
> Illustrated: [PLAN_HOVER_HIGHLIGHT.html](PLAN_HOVER_HIGHLIGHT.html).

**Scope: editor layer only.** One new pure module (`src/modeler/vpl/hoverHighlight.ts`), a CSS block in
`GraphEditor.module.css`, wiring in `GraphEditor.tsx` (+ a one-line channel in `graphState.ts` for the
port-precise refinement), a Node harness, one Help line. **ZERO compiler impact** — no schema field, no
worker message, no emitted surface, no persisted setting in v1. `check-compile-identity` must report
*"31 models, all surfaces unchanged"* and that is a gate, not an expectation.

---

## 1 · The request

Verbatim:

> when user hovers over a node, the node itself highlights a bit (perhaps similar to the glow that was
> being used for the Trace feature, but of the color of the node category instead of always
> purple/magenta), and if the hover is towards the left third of the node, then all of its input links
> and the nodes consuming it would glow as well; and if the hover is on the right third side of the
> node, the output links, and all respective consumer nodes would be highlighted as well.

Read as three rules — **self** (any hover), **left third = inputs** (the wires INTO the node and the
nodes that PRODUCE them), **right third = outputs** (the wires OUT and the nodes that CONSUME them) —
plus the colour rule: the hue is the hovered node's own, not the trace violet.

**Verdict: feasible, cheap, and low-risk**, because the Rule Trace already built the exact mechanism
this needs (an imperative `data-*` highlighter that never touches React state) and left three unused
seams on the `<ReactFlow>` element. The one non-obvious finding is about colour (§2.3): the node fills
are deliberately dark, and as a glow they are invisible — the glow has to be a lightened derivative.

---

## 2 · Investigation findings — what the editor does today

### 2.1 Hover, today

| What | Where | Note |
|---|---|---|
| CaNode `onMouseEnter` / `onMouseLeave` | [CaNode.tsx:1384–1404](../src/modeler/vpl/CaNode.tsx) | ONLY the hover-to-uncollapse disambiguation during a wire drag; returns immediately unless `isConnectingGlobal` |
| `.reroute:hover { filter: brightness(1.18) }` | [RerouteNodeComponent.module.css:15](../src/modeler/vpl/RerouteNodeComponent.module.css) | the single hover highlight on the canvas today |
| the magenta handle glow | [CaNode.module.css:210](../src/modeler/vpl/CaNode.module.css) `.handleCompatible` | during a connection drag only — it OWNS the canvas while a wire is being pulled |
| `onNodeMouseEnter` / `onNodeMouseLeave` / `onEdgeMouseEnter` / `onEdgeMouseLeave` | [GraphEditor.tsx:6340–6343](../src/modeler/vpl/GraphEditor.tsx) → `onTraceNodeEnter` etc. ([:1553–1565](../src/modeler/vpl/GraphEditor.tsx)) | the Rule Trace tooltip; gated by `traceHoverAllowed()` = a trace is on screen AND no drag AND no connection |
| `onNodeMouseMove` / `onEdgeMouseMove` | React Flow 12.10 (`component-props.d.ts:57` / `:75`) | **exist, unused** — the seam the thirds need |

The trace tooltip and this feature will share the enter/leave props: one composed handler calls both.
They do not compete — the tooltip is a portalled box beside the cursor, the highlight is on the graph.

### 2.2 The template: the Rule Trace highlighter

[GraphEditor.tsx:1164–1540](../src/modeler/vpl/GraphEditor.tsx) is a complete worked example of exactly
this shape of feature, with its lessons recorded in
[`areas/modeler-ui.md`](areas/modeler-ui.md) § *RULE TRACE* and [`areas/rule-trace.md`](areas/rule-trace.md)
§ *The graph editor*:

- **An ATTRIBUTE, never a class.** React Flow rebuilds `className` on every render
  (`index.js:2219` / `:2909`), so an imperative class is wiped the moment the node is selected. React
  writes no unknown attribute, so `data-trace` survives. The hover uses `data-hover` the same way.
- **No React state.** ONE subscriber computes a set and writes the DOM; `setNodes` / `setEdges` are
  never called; `CaNode` never re-renders. A hover moves far more often than a trace lands (a trace
  is ≤30×/s; a mouse is 60–120×/s), so this is even more load-bearing here.
- **Elements by `data-id`**, cached in a map revalidated with `isConnected` (`traceElFor`,
  [:1216](../src/modeler/vpl/GraphEditor.tsx)) — reusable as-is.
- **The wire colour needs `!important`**: `toRFEdges` ([:671–679](../src/modeler/vpl/GraphEditor.tsx))
  puts `stroke: #66bb6a` (flow) / `#4cc9f0` (value) in an INLINE style on the path.
- **Selection must still read** (`.react-flow__node.selected` ring at
  [GraphEditor.module.css:262](../src/modeler/vpl/GraphEditor.module.css); selected wire red at `:276`).
- **`prefers-reduced-motion`** turns animations off; **unmount** removes every mark (the editor
  unmounts on every Modeler ↔ Simulator switch).
- The trace's **mount race** (marks written before the scope's nodes exist) does not apply: a hover
  only ever marks elements the mouse is over or adjacent to, which exist by construction.

### 2.3 Colour — the one real finding

The header fill is `def.color`, a **hex literal per node definition** in `src/modeler/vpl/nodes/*.ts`
(`conditional` `#1b5e20`, `getCellAttribute` `#b71c1c`, `setAttribute` `#4a148c`, macro instance
`#5e35b1`, `expression` `#b8860b`, aggregation `#e65100`, the event roots `#ffffff`, …), painted at
[CaNode.tsx:2059](../src/modeler/vpl/CaNode.tsx) and already used for the node's own border via
`borderColorFor(def.color)` ([:176](../src/modeler/vpl/CaNode.tsx), light fills get `#b0b8c0`).
So "the colour of the node category" the user sees **is `def.color`** — the seven `--color-node-*`
tokens in [tokens.css:96–102](../src/styles/tokens.css) are defined but consumed by nothing
(`grep -rn "color-node-" src --include=*.ts*` → 0 hits). Reading `def.color` needs only
`getNodeDef(nodeType)`, already imported in `GraphEditor.tsx:36`.

**Those fills are deliberately dark and muted** (the Blender compositor palette). The prototype's first
pass used `#1b5e20` raw as the ring + halo of the If node and it was **invisible at 1× against the
canvas** — a 2 px ring in the header's own colour reads as "no change" because the border is already
that colour. The glow therefore has to be a **lightened derivative**: the prototype's second pass used
`color-mix(in oklab, c 55%, white)` and every node type read clearly (`#1b5e20` → a mint, `#b71c1c` → a
salmon, `#4a148c` → a lavender). Two ways to get it, and the plan picks the first:

1. **Compute in TypeScript** — `hoverGlowColor(hex)` = the same 55/45 mix done on the RGB bytes, written
   as `--hover-c` (one inline custom property per marked element). Zero browser dependency, one
   function, harness-testable, and the value is visible in the DOM for verification.
2. CSS `color-mix()` from the raw hue — needs Chromium ≥ 111 (fine for both the web build and the
   Tauri WebView2 shell), but the harness could not check the derived colour and DevTools shows only
   the input. Listed as the alternative.

A light fill (the white event roots, luminance > 0.6 — the `borderColorFor` test) lightens to itself;
a white glow on the dark canvas reads fine and is what the prototype showed.

### 2.4 The DOM — where the marks can live, verified

| Element | React-owned inline style? | Consequence |
|---|---|---|
| `.react-flow__node[data-id]` wrapper | YES — `{ zIndex, transform, pointerEvents, visibility, ...node.style }` (`index.js:2219`) | React diffs only the keys IT rendered, so a custom property set imperatively (`el.style.setProperty('--hover-c', …)`) is left alone. **Verified live** (§2.10): after `addSelectedNodes` re-rendered the wrapper with `z-index: 1000` and the `selected` class, it still carried `data-hover="self"` and `--hover-c`. |
| `.react-flow__edge` `<g>` | NO style prop at all (`index.js:2909`) | trivially safe; the path under it carries the inline stroke |
| the inner `.node` div (CaNode's root) | CaNode's own (`borderColor`, `minHeight`, `width`) | **this is where the hover ring goes** — see §3.2 |

### 2.5 Adjacency — what the hover needs, and what already exists

The trace builds a reroute-resolved wire index once per graph change
([traceGraphMap.ts:72 `EditorTraceIndex`](../src/trace/traceGraphMap.ts), `buildEditorTraceIndex` at
`:111`, cached in `traceIndexRef` keyed on the edge array's identity + the node count —
[GraphEditor.tsx:1196](../src/modeler/vpl/GraphEditor.tsx)). It resolves every wire to its ORIGIN port
and real TARGETS, which is the trace's question ("did a value travel here?"). The hover asks a
different one: **which editor edges and which dots lie between this node and its real neighbours** —
it has to light every SEGMENT of a reroute chain plus the dots, not just the endpoints. So the hover
gets its own tiny index (`inByNode` / `outByNode` / `reroutes`), built by the same rule
(`isValidConnection` guarantees a reroute has exactly one inbound wire; "first inbound wins" as the
defensive fallback, exactly as `collapseReroutes` and the trace index do) and cached on the same key.
Cost per gesture is O(degree × chain length); the largest shipped scope is 91 nodes.

### 2.6 Geometry for the thirds

`onNodeMouseMove(event, node)` fires on the wrapper, so `event.currentTarget.getBoundingClientRect()`
is the node's SCREEN box and `(clientX − left) / width` is a zoom-independent ratio. One layout read
per move; the handler writes the DOM **only when the zone changes**, after the read, so it can never
force a layout in the same frame. Zone edges at ⅓ / ⅔ with **hysteresis** (enter left below 0.30,
leave it above 0.36; mirrored on the right) so a cursor resting on a boundary cannot flap.

Cases the ratio must not mis-handle: a **collapsed** strip is ~25 px tall but ≥ 80 px wide, so thirds
still work; a **reroute dot** is 16 px — no thirds, hovering it lights BOTH sides; a collapsed
**constant pill** has no inputs, so its left third lights nothing beyond itself (honest, not
"fall through to the outputs"); a **macro instance** has real ports on both sides; inside a def the
`macroInput` / `macroOutput` boundary nodes participate normally; **groups and comments** carry no
wires and are skipped by type.

### 2.7 Gestures that must stand the hover DOWN

| Gesture | Signal | Why |
|---|---|---|
| wire drag | `isConnectingGlobal` ([graphState.ts:41](../src/modeler/vpl/graphState.ts)) | the magenta compatibility glow owns the canvas; two glows at once is noise |
| node drag | `nodeDragActiveRef` ([GraphEditor.tsx:2810](../src/modeler/vpl/GraphEditor.tsx), set in `onNodeDragStart`) | the trace tooltip stands down here for the same reason |
| box select | React Flow's pane owns the pointer; `onNodeMouseEnter` still fires when the rubber band crosses a node | clear on `onSelectionStart`, ignore enters until `onSelectionEnd` |
| a context menu opening | the node under the menu keeps its mark; harmless, but clear it on menu open for tidiness | |
| scope change / graph-kind switch / unmount | the trace's cleanup precedent | no stale mark on a remounted element |
| the hovered node deleted under the cursor (Delete key) | `mouseleave` never fires | re-validate on `nodes.length` change: if the hovered id is gone, clear |

Live mode changes nothing: its input-ownership rules (`modeler-ui.md` § *LIVE mode — INPUT OWNERSHIP*)
are about the keyboard; hover is mouse-only and the graph pane already receives it.

### 2.8 Performance

Measured in the prototype: applying a degree-2 set = **0.3 ms** of DOM writes, no React render. A node
with 40 consumers (a fan-out from one Get Cell Attribute) writes ~80 attributes — still well under a
frame. The one thing to measure, not assume, is `filter: drop-shadow` on SVG paths (Chromium rasterises
each filtered path); the fallback is colour + width only. A DEV probe `window.__hoverPerf` mirrors
`__traceMarkPerf`.

### 2.9 Both themes

The glow derives from `def.color`, which is theme-independent; only the canvas behind it changes
(Blender `--color-bg-canvas` vs Nocturne's). The 55 % lightening reads on both in the prototype; the
real-UI pass measures each theme.

### 2.10 The prototype (evidence, not a build)

Run against `Game Of Life` in the dev server, from the page console, with the React Flow store reached
through the fiber walk `modeler-ui.md` documents. It injected a `<style>` with `[data-hover]` rules
and set `data-hover` + `--hover-c` on the If node, its in-wires and their sources (left), then its
out-wires and their targets (right). Observed:

- **Left**: the If node ringed in mint; the flow wire from Generation Step and the value wire from Get
  Cell Attribute recoloured mint and haloed; both feeding nodes ringed fainter. The two dark-green
  first-pass rings were invisible — the lightening is required (§2.3).
- **Right**: the THEN and ELSE wires and both downstream If nodes lit; nothing else moved.
- **Re-render survival**: `addSelectedNodes([ifId])` → wrapper style became
  `z-index: 1000; transform: …; pointer-events: all; visibility: visible; --hover-c: rgb(27, 94, 32)`
  with the `selected` class, `data-hover="self"` intact, and the edge kept `data-hover="out"` + its
  property. The red selection ring (on the wrapper) and the mint hover ring (on the inner `.node`) were
  both readable at once.
- Apply cost 0.3 ms; 0 console errors; the style tag, attributes and properties were removed afterwards.

---

## 3 · The proposed UX

### 3.1 The three zones (the spec, plus hysteresis)

| Cursor | Lights | Tokens written |
|---|---|---|
| anywhere on the node | the node itself | node `self` |
| left third | + every wire INTO the node, through any reroute chain, + the real producer at the far end of each | wires `in`, dots `relay`, producers `peer` |
| right third | + every wire OUT of the node, through any reroute fan-out, + every real consumer | wires `out`, dots `relay`, consumers `peer` |
| middle third | the node only | — |

The self mark appears **immediately** (a 120 ms CSS transition on the shadow). The neighbourhood
appears after a short **dwell** (`HOVER_DWELL_MS = 90`): crossing a dense graph on the way somewhere
must not strobe every wire the cursor passes. Once lit, moving between thirds switches sides at once.

### 3.2 The colour language — one hue per gesture

Everything lit by one hover uses **the hovered node's own hue**, lightened (§2.3): a 2 px ring + 16 px
halo on the node, a 1.5 px ring + 10 px halo on the peers (fainter, so the origin of the gesture stays
obvious), and the wires restroked in the hue at 3.2 px with a 3 px halo. The single hue is what makes
the set read as *"these belong to the thing under my cursor"* — the port glyphs (triangle vs circle)
still say flow vs value.

**The hover ring goes on the INNER `.node` element**, not the wrapper. The wrapper already carries two
box-shadow languages — the red selection ring (`.selected`) and the violet trace glow (`data-trace`) —
with paired rules so they compose. A third shadow on the same element would need 2³ combination rules.
On the inner element the hover ring simply sits INSIDE the selection ring and the trace halo, composes
with both for free, and the prototype showed exactly that.

Wires: `.react-flow__edge:not(.selected)[data-hover]` — a selected wire stays red (the editor's
selection language, the trace's precedent). A wire that is BOTH trace-lit and hovered shows the hover
hue while hovered and the trace violet on leave: the hover rule is declared after the trace block at the
same specificity, and that ordering is documented as deliberate.

### 3.3 Reroutes

Hovering a **dot** lights both sides (no thirds on 16 px). Hovering a node whose wire arrives through
`A → r1 → r2 → node` lights all three segments, both dots (`relay`, a ring in the hue) and `A` as the
peer. A dot that fans out to three consumers lights all three when its producer's right third is
hovered.

### 3.4 Doctrine

No new control in v1 — this is ambient feedback with nothing to configure, so there is nothing to hide
or grey. If it proves distracting in practice, an on/off in the persisted view-settings block
(`hoverHighlightGlobal`, the port-labels / grid / snap precedent) is a ten-line follow-up; a canvas
toggle button is NOT proposed, the row of four is enough. `prefers-reduced-motion` drops the transitions.

### 3.5 Improvements and alternatives (the user asked for them)

| # | Idea | Cost | Verdict |
|---|---|---|---|
| **I1 Port-precise** | hovering a specific **handle** narrows the set to THAT port's wire(s) and endpoint(s). The thirds are the coarse default; the handle is the precise one. `<Handle onMouseEnter>` in CaNode publishes `{nodeId, handleId}` on a `graphState` channel; the editor treats it as a zone override. | small | **v1** — it is the natural refinement of the thirds and answers "which of these five inputs is that wire?" |
| **I2 Wire hover** | hovering a **wire** lights the wire and BOTH endpoints (through a reroute chain). The 15 px `interactionWidth` hit area already exists. Hue = the producer's. | small | **v1** — the biggest win for long wires and reroute chains, where the question is always "where does this go?" |
| **I3 Transitive cone** | with **Alt** held, the left / right third extends to the full upstream / downstream closure (Blender *Select Linked*, Houdini upstream). Bounded BFS, cap 200 nodes, dots included. | medium | **v2** — valuable for "what does this eventually affect", but a modifier-hover is a discoverability problem; ship the basic gesture first |
| I4 Focus / dim mode | dim everything NOT in the set (Unreal's hover-dim). | small | **not as default** — the trace doctrine is *adds light, never greys the graph*, and a transient dim on every mouse pass flickers the whole canvas. Could be the Alt variant's look instead of I3's extension; decide after I3 |
| I5 Off-screen chevron | when a lit peer is outside the viewport, a small marker at the viewport edge pointing to it | medium | note only — the Organize feature removes most of the need |
| I6 Sticky on selection | a selected node keeps its in/out lit | tiny | **no** — collides with the selection language (red) and with the trace's lit path; hover is transient by design |
| I7 Explorer cross-highlight | hovering a row in the Node Explorer lights that node on the canvas | small | v2 — same DOM writer, one more caller |
| A1 wires keep their own hue | brighten + thicken the flow green / value cyan instead of restroking in the node hue | — | alternative to §3.2; preserves the flow/value colour code on the wire itself at the cost of the "one set, one hue" reading. The port glyphs already carry that code, so the plan recommends the node hue — a decision for the user (§9) |
| A2 middle third = both sides, faint | instead of node-only | — | alternative; the plan keeps the user's spec (the middle is the "just looking" zone) |
| A3 no dwell | neighbourhood lights on enter | — | alternative; the plan recommends 90 ms and keeps it one constant |

---

## 4 · Design

### 4.1 The pure module — `src/modeler/vpl/hoverHighlight.ts` (DOM-free)

```ts
export type HoverZone = 'self' | 'in' | 'out' | 'both';
export type HoverTarget =
  | { kind: 'node'; id: string; zone: HoverZone }
  | { kind: 'port'; nodeId: string; handleId: string }      // I1
  | { kind: 'edge'; id: string };                           // I2
export interface HoverIndex { inByNode; outByNode; reroutes: Set<string>; kindOf: Map<string, 'node'|'reroute'|'other'> }
export interface HoverMarks { nodes: Map<string, 'self'|'peer'|'relay'>; edges: Map<string, 'in'|'out'|'wire'>; originId: string }
export function buildHoverIndex(nodes, edges): HoverIndex           // O(N+E), cached per graph change
export function computeHoverMarks(index, target, opts?: { transitive?: boolean; cap?: number }): HoverMarks
export function zoneForRatio(ratio: number, prev: HoverZone | null): HoverZone   // the hysteresis
export function hoverGlowColor(hex: string): string                  // the 55/45 lightening
```

The reroute walk: from an in-edge whose source is a reroute, follow that dot's single inbound wire
upstream (marking the dot `relay` and each segment `in`) until a non-reroute — that node is the `peer`;
from an out-edge whose target is a reroute, follow every outbound wire (a dot fans out) until
non-reroutes. Cycle-guarded with a `seen` set (hand-edited files). `originId` names the hovered
element so the editor can look up its `def.color` once.

### 4.2 Wiring in `GraphEditor.tsx`

- `hoverIndexRef` — same key as `traceIndexRef` (edge array identity + `nodes.length`).
- `hoverMarkedRef` / the shared `traceElFor` element cache (rename to `markElFor`; it is not
  trace-specific) — the trace's own cache map stays separate.
- `hoverStateRef` — `{ target, zone, dwellTimer }`; **no React state anywhere**.
- `applyHoverMarks(marks | null)`: remove `data-hover` + `--hover-c` from the previous set, set them
  on the new (attribute + property; `setAttribute` on an unchanged value is free); colour =
  `hoverGlowColor(getNodeDef(originNodeType).color)`.
- Handlers, composed with the trace tooltip's: `onNodeMouseEnter` (self, arm the dwell),
  `onNodeMouseMove` (ratio → `zoneForRatio`; write only on change), `onNodeMouseLeave` (clear),
  `onEdgeMouseEnter` / `onEdgeMouseLeave` (I2), a `subscribeHoveredPort` channel (I1).
- Stand-down: `if (isConnectingGlobal || nodeDragActiveRef.current) return` at every entry;
  `onNodeDragStart` / `onConnectStart` / `onSelectionStart` / scope effect / unmount → `applyHoverMarks(null)`.
- Re-validate on `[nodes.length, edges]` (the trace's second effect): the hovered node may be gone.
- DEV hooks `window.__hoverMarks()` / `__hoverPerf` (the `__traceMarks` precedent).

### 4.3 CSS — a `HOVER HIGHLIGHT` block in `GraphEditor.module.css`, AFTER the trace block

```css
:global(.react-flow__node[data-hover~="self"]) > * { box-shadow: 0 0 0 2px var(--hover-c), 0 0 16px 3px color-mix(in srgb, var(--hover-c) 55%, transparent); transition: box-shadow var(--duration-base); }
:global(.react-flow__node[data-hover~="peer"]) > * { box-shadow: 0 0 0 1.5px var(--hover-c), 0 0 10px 1px color-mix(in srgb, var(--hover-c) 40%, transparent); }
:global(.react-flow__node[data-hover~="relay"]) > * { box-shadow: 0 0 0 2px var(--hover-c); }
:global(.react-flow__edge:not(.selected)[data-hover] .react-flow__edge-path) { stroke: var(--hover-c) !important; stroke-width: 3.2 !important; }
@media (prefers-reduced-motion: reduce) { …transition: none }
```

`> *` is CaNode's root `.node` (or the `.reroute` dot). The translucent halo colour is the one place
`color-mix` is convenient; if it is to be avoided entirely, write a second property `--hover-c-soft`
from TS. The wire `drop-shadow` filter is opt-in after measuring (§2.8).

### 4.4 CaNode (I1 only)

`<Handle onMouseEnter/onMouseLeave>` → `setHoveredPort({ nodeId, handleId } | null)` in `graphState.ts`
(module global + listener set, the `connectingFrom` pattern; the editor reads it through a subscription
into a ref — never React state). CaNode itself renders nothing for it.

---

## 5 · Verification plan

### 5.1 The pure module — `scripts/verify-hover-highlight.mjs` (house style)

esbuild-bundles the shipped `hoverHighlight.ts`, asserts VALUES, every claim negative-controlled.

| # | Assertion | Fixture |
|---|---|---|
| H1 | left third = exactly the in-edges + their real sources; nothing from the out side | chain `A → B → C` + a value feed `V → B` |
| H2 | right third = exactly the out-edges + real targets | same |
| H3 | middle = `{self}` only | same |
| H4 | reroute chain `A → r1 → r2 → B`: hovering B-left marks 3 segments, 2 `relay` dots, A `peer` | reroute fixture |
| H5 | reroute fan-out `A → r → {B, C}`: A-right marks 3 segments, 1 dot, 2 peers | |
| H6 | hovering a dot = both sides | |
| H7 | edge hover = the wire + both real endpoints, through chains (I2) | |
| H8 | port hover narrows to that handle's wires (I1); an unwired port = self only | |
| H9 | `zoneForRatio` hysteresis: `0.31, 0.34, 0.35` stay left after entering at `0.29`; `0.37` leaves | |
| H10 | transitive cone bounded by `cap`; cycle-guarded on a hand-made cyclic reroute pair | |
| H11 | `hoverGlowColor` pins whichever curve P1 settles on (a 55/45 white mix gives `#1b5e20 → #82a684` but desaturates; an HSL lightness lift to ~62 % keeps the hue vivid and is the likely pick); `#ffffff → #ffffff`; lower-case + 3-digit input tolerated | |
| H12 | LIBRARY SWEEP — every shipped model, every scope, every node, all three zones: every marked edge touches a marked node, no id outside the scope, `|in| + |out|` through reroutes = the node's real degree | 31 models |
| controls | drop the reroute walk → H4/H5/H12 fail; swap in/out → H1/H2; drop hysteresis → H9; drop the cap → H10; lighten with the wrong ratio → H11 | ≥ 5 source mutations, each must FAIL |

### 5.2 Through the real UI (the standing rule: never conclude "works" from a direct call)

Dev server; real `hover` moves at the left / middle / right thirds of a node; `__hoverMarks()` read back:

- **Game of Life** — the three zones on the If node (the prototype's shapes, now driven by the mouse).
- **Accretor** — 5 reroutes: a chain lights every segment and dot; hovering a dot lights both sides.
- **Amphiphile** — 91 nodes, the fan-outs: `__hoverPerf` max under 1 ms; no frame drop while sweeping.
- **Kelp War inside a macro def** — boundary nodes participate; leaving the def clears.
- Selection re-render keeps the marks; a node drag, a wire drag and a box-select stand it down;
  Delete under the cursor clears; the trace tooltip still appears beside it in Live with a trace on.
- Live while playing: 0 React re-renders attributable to hover (React DevTools profiler / the
  `CaNode` memo).
- Both themes; `prefers-reduced-motion` emulated; **0 console errors**.

### 5.3 Gates

`npx tsc -b` · `npm run build` · `node scripts/check-compile-identity.mjs --compare <baseline>` (31
models, all surfaces unchanged) · `verify-auto-layout.mjs` and `verify-handle-remeasure.mjs` still green.

---

## 6 · Risk map

| # | Risk | Mitigation |
|---|---|---|
| R1 | the raw hue is invisible as a glow | lighten in TS (§2.3); H11 pins the function; the real-UI pass looks at every category in both themes |
| R2 | per-move cost (`getBoundingClientRect` on every `mousemove`) | one read, write only on zone change, after the read; `__hoverPerf` gate |
| R3 | flicker while crossing a dense graph | dwell (90 ms) + hysteresis; both are single constants |
| R4 | three shadow languages on one element (selection / trace / hover) | hover on the INNER element; wires ordered after the trace block; verified with a trace on |
| R5 | React Flow wipes the mark on re-render | attribute + custom property, both verified to survive (§2.10) |
| R6 | stale marks after scope change / unmount / deletion / graph switch | clear in the scope effect, on unmount, and on `[nodes.length, edges]` (the trace precedent) |
| R7 | `mouseleave` never fires (node removed, menu opened over it, native `<select>` popup steals the pointer) | the re-validation above + clear on menu open; the `<select>` case just clears on the next leave |
| R8 | the hover fights the connection-drag glow | hard stand-down on `isConnectingGlobal`, the trace tooltip's rule |
| R9 | `filter: drop-shadow` on 40 lit paths | opt-in after measuring; the fallback is colour + width, which the prototype showed is enough |
| R10 | `color-mix` support | used only for the translucent halo; replaceable by a second TS-computed property |
| R11 | groups (`pointer-events: none` body) and comments | skipped by node type; a group header hover does nothing |
| R12 | Live's split workspace mounts the same editor | the element cache is scoped to `editorWrapperRef`, per instance |
| R13 | touch devices | no hover, nothing happens, nothing to guard |
| R14 | the trace tooltip handler and this one both on `onNodeMouseEnter` | one composed callback; each keeps its own gate |

---

## 7 · Phasing

| Phase | Delivers | Gate |
|---|---|---|
| **P1** | `hoverHighlight.ts` (zones, reroute walk, lightening, hysteresis) + editor wiring + CSS + harness H1–H6/H9/H11/H12 + controls + the GoL / Accretor / Amphiphile real-UI pass | tsc / build / identity green; `__hoverPerf` < 1 ms |
| **P2** | I1 port-precise + I2 wire hover (+ H7/H8), the Help line, the `modeler-ui.md` section, project-structure + harness index | same |
| **P3 (optional)** | I3 Alt-cone (+ H10), I7 Explorer cross-highlight, the view-settings toggle if the user wants one | same |

---

## 8 · Docs to update on delivery

1. `docs/areas/modeler-ui.md` — a *Hover highlight* subsection (the zones, the inner-element decision,
   the hover-over-trace precedence, the stand-down list, the dwell/hysteresis constants); the `data-*`
   attribute rule is already general and gets a "the hover follows it" sentence.
2. `docs/areas/rule-trace.md` — one line under *The graph editor*: a hovered wire shows the hover hue
   over the trace violet while hovered.
3. `docs/areas/project-structure.md` — `hoverHighlight.ts`, `verify-hover-highlight.mjs`.
4. `docs/areas/testing-harnesses.md` — index row; count 69 → 70 (and the one number in `CLAUDE.md`).
5. `src/help/HelpView.tsx` — one bullet in *Canvas Controls* ("Hover a node …").
6. `README.md` — unchanged (editor convenience; no Features sentence moves).

---

## 9 · Decisions for the user

| # | Question | Recommendation |
|---|---|---|
| D1 | Wires restroked in the hovered node's hue, or brightened in their own flow/value hue (A1)? | node hue — one set, one hue |
| D2 | Middle third = node only (as specified), or both sides faint (A2)? | as specified |
| D3 | 90 ms dwell before the neighbourhood lights, or immediate (A3)? | dwell |
| D4 | Port-precise (I1) and wire hover (I2) in v1? | yes, as P2 on the same branch |
| D5 | Alt-hover transitive cone (I3): v2, or drop? | v2, after living with the basic gesture |
| D6 | A view-settings on/off? | not in v1 |

---

## As built — deviations

Every place the shipped feature differs from the plan above, and why. P1 = commit `f3ecf0e`, P2 = the
follow-up commit on the same branch. Reference documentation:
[`areas/modeler-ui.md`](areas/modeler-ui.md) § *Hover highlight*.

| # | Plan said | Shipped | Why |
|---|---|---|---|
| 1 | §3.2 / D1: everything lit by one hover uses **the hovered node's hue** | **Every element glows in its OWN colour** — the node in its lightened `def.color`, each peer in its own, a wire and a reroute dot in their wire's category colour | **User decision D1 overrode the recommendation** (the plan's A1 alternative, chosen). It moves the colour out of the stylesheet entirely: it is now an inline `--hover-c` per element rather than one value per gesture |
| 2 | §2.3 / §4.1: `hoverGlowColor` = "the same 55/45 mix done on the RGB bytes" | an **HSL LIGHTNESS LIFT** keeping hue + saturation (`HOVER_GLOW_L = .62` nodes, `HOVER_WIRE_GLOW_L = .72` wires); a fill already at/above the target is returned unchanged | a mix towards white DESATURATES, which reads as "greyed" on the dark fills; H11 pins both curves and asserts the lifted green is still green-dominant. The white event roots stay white for free |
| 3 | §4.3: the translucent halo is the one place `color-mix` is convenient | a **second TS-computed property `--hover-c-soft`** (`hoverSoftColor`) | removes the feature's only `color-mix` dependency (risk R10) AND makes the derived value readable in the DOM, so the real-UI pass verifies the halo it is looking at instead of inferring it |
| 4 | §3.1: the neighbourhood appears after the dwell; nothing about a WIRE's dwell | a **wire hover waits the same one `HOVER_DWELL_MS` for its WHOLE set** (P2) | a wire has no "self" half that could light early and still be the answer, and a cursor crossing a bundle of wires would otherwise strobe every one of them. Kept as ONE constant, per D3 |
| 5 | §3.5 I1: "the editor treats it as a zone override" (no more detail) | the override applies **only while its `nodeId` equals the live gesture's origin**, is tracked even across a `clearHover`, and **never re-arms the dwell**; leaving the handle resumes the third because `st.zone` is tracked from the ratio all along | the handle is INSIDE the node wrapper, so the real event order is node-enter → port-enter → port-leave → node-move… → node-leave. Making the port a subject of its own would double-arm the dwell and lose the third |
| 6 | §3.3 / §3.5 I1: nothing about a handle ON a dot | **a handle on a reroute dot is treated as the dot** — both sides, whichever of its parts the cursor is on | the dot is 16 px and its two handles COVER it, so a directional reading would make P1's verified "hovering a dot lights both sides" unreachable with a real mouse. Control 10 pins it |
| 7 | §3.5 I2: "hovering a wire lights the wire and BOTH endpoints… Hue = the producer's" | the **whole reroute chain** the wire belongs to, upstream to the real producer and downstream to every real consumer — but a **sibling branch of a fan-out the wire is not on stays dark**; hue per element (deviation 1) | "where does THIS wire go?" is the question; the sibling branch is a different wire's answer. H7 asserts trunk-vs-branch separately on the fan-out fixture |
| 8 | §4.1: `HoverMarks.edges` tokens `'in' \| 'out' \| 'wire'` with no styling note | the `wire` token is shipped **and needs no CSS rule of its own** — the edge rule matches the ATTRIBUTE's presence | every edge token then styles identically by construction and only `--hover-c` varies, which is what deviation 1 requires. Recorded in the CSS block's token list |
| 9 | §4.2: `applyHoverMarks` removes the marks from the previous set and sets them on the new | it re-applies **unconditionally to every current member**, not just to the diff's additions | React Flow can REMOUNT an element (dropping the attribute) without the set changing — the trace highlighter's own discipline; `setAttribute` on an unchanged value is free |
| 10 | §4.2: `hoverMarkedRef` / "rename `traceElFor` to `markElFor`" | done, and the **unmount cleanup walks the one shared cache** dropping `data-trace`, `data-hover` and both custom properties in a single pass; each feature keeps its own marked-set | one cleanup, no way for either feature to clear the other's attribute |
| 11 | §4.4: CaNode's `<Handle onMouseEnter/onMouseLeave>` publishes | the two publishers are **module-level functions in `graphState.ts`**, not closures in CaNode, and read `data-nodeid` / `data-handleid` off React Flow's own handle div. The leave is **conditional** (it clears only while the channel still names that handle) | one shared pair of references for the whole graph: CaNode gains no state, no subscription and no new callback identity per render, so its `memo` keeps skipping. `graphState` stays React-import-free via a structural `HandleHoverEvent` (the `ScopeDragPointer` precedent). The conditional leave makes the delivery order of an adjacent leave/enter pair irrelevant |
| 12 | §2.7: the stand-down table lists the gestures | shipped as ONE `hoverAllowed()` predicate (connect / node drag / box select / context menu) + a scope-effect, unmount and `[nodes.length, edges]` re-validation, **which checks the EDGE array when the subject is an edge**; a **pointerdown on a wire** additionally clears inside the link-splice gesture's own `onDown` | the press either selects the wire or opens a menu over it and `mouseleave` may never come (risk R7, on a subject the plan had not yet introduced) |
| 13 | §2.1: `onNodeMouseMove` / `onEdgeMouseMove` are "exist, unused" seams | **both are now used**: the node one drives the thirds, and the edge one exists to RE-ARM after the pointerdown clear above | without it a wire pressed and released under the cursor stays dark until the user leaves and comes back |
| 14 | §2.7 / R7: nothing about a mousemove with no preceding enter | **a `mousemove` on a node the gesture never got an `enter` for re-arms it** | React Flow fires exactly that when a stand-down lifts with the cursor still on the node — a node drag that ended there. Found in the real-UI pass, not in the plan |
| 15 | §5.1 H12: "every shipped model, every scope, every node, all three zones" | section C additionally probes **every wired HANDLE** (port set ⊆ its third, and the union over a side's handles == that third) and **every WIRE**, against a second, wire-seeded oracle | the two P2 subjects are not nodes, so the node-frontier oracle cannot express them |
| 16 | §5.1: "≥ 5 source mutations" | **11** negative controls, 11/11 discriminating | P2 added 4 (the port walk must read the handle; a wire must light both ways; a dot's handle is the dot; one `seen` set per direction). The anchors are also EOL-tolerant now — `core.autocrlf` checks the sources out as CRLF while the harness is written with `\n`, which had silently turned every multi-line anchor into "anchor GONE" |
| 17 | — (not anticipated) | **one `seen` set PER DIRECTION** in the chain walk | sharing one set between the up- and down-walk truncated the downstream half of a chain whenever a dot was reachable both ways — i.e. only on a hand-edited cyclic dot pair. Caught by H7's cyclic fixture while P2 was being written; control 11 exists so it cannot come back |
| 18 | §5.2: "real `hover` moves… `__hoverMarks()` read back" | the same, plus the finding that **a hidden preview pane throttles `setTimeout` to ≥ 1 s**, so the 90 ms dwell fires late and a read taken 200 ms after the hover finds nothing | it looks exactly like a broken feature and is not. Documented in the area doc's verification recipe |
| 19 | §3.5 I1: "the hovered HANDLE itself may get a small ring" (implied by "port-precise") | **no ring on the handle itself** | the port's wire lighting IS the feedback and it is drawn right at the handle; a third element class in the writer (handles are React Flow-rendered divs with rebuilt `className`s, so it would need the attribute mechanism too) buys nothing the wire does not already say |
| 20 | §7 P2 row: "+ the Help line, the `modeler-ui.md` section, project-structure + harness index" | all done, plus `rule-trace.md` (the shared `markElFor` + the hover-over-trace precedence), the `data-trace`-is-an-attribute bullet's "the hover follows it" sentence, the harness count 69 → 70 in `testing-harnesses.md` AND `CLAUDE.md`, and this section | the Documentation-consistency rule; `README.md` was checked and is deliberately unchanged (an editor convenience moves none of its one-to-three-sentence Features summaries) |
| 21 | §4.1: `computeHoverMarks(index, target, opts?)` with `transitive` / `cap` | signature shipped as planned; `opts` is still **unread** | it is the P3 Alt-cone seam and was accepted early so the signature would not move later. H10 stays absent with it |

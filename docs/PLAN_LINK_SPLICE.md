# Plan — Press-and-hold a LINK to SPLICE a node into it

**Scope: editor layer only.** `GraphEditor.tsx` (+ a DEV hook). ZERO compiler impact —
nothing under `src/modeler/vpl/compiler/` changes, no schema field, no worker message.

Illustrated: [PLAN_LINK_SPLICE.html](PLAN_LINK_SPLICE.html).

---

## 1. The gap

The press-and-hold-on-a-wire gesture ([GraphEditor.tsx](../src/modeler/vpl/GraphEditor.tsx),
the `HOLD_MS = 550` effect) can insert exactly ONE thing: a **reroute dot**. Everything
else a user wants to put *on* an existing wire — scale a constant with a Math node, gate a
flow chain behind a Conditional, clamp a value — is a five-step manual chore: add the node
somewhere, drag a wire from the source, drag another wire to the consumer, delete the
original edge, tidy the position.

The user's ask (verbatim):

> Holding down a link could popup the add node dialog with the addition of the reroute
> option, and the nodes available be the ones compatible with the source of that link, so
> that the user could add a node there and automatically have the link connected to it (and
> removed from the older consumer of that link). And if the new node inserted there has an
> output that is compatible with the older consumer port of the original link, then its
> output gets automatically connected to it.

## 2. The gesture (unchanged shape, new payload)

```
LMB-press on a wire ──┬─ release < 550ms ──────────────► edge SELECT      (untouched)
                      ├─ move > 6px before 550ms ──────► cancel → pan / box-select (untouched)
                      └─ hold 550ms ───────────────────► ★ SPLICE MENU opens at the hold point
```

Double-click-to-delete an edge, RMB-pan-through-edges and normal reroute node dragging are
all untouched — the handler still only arms on `.react-flow__edge` and still cancels on
movement.

**UX change, deliberate and noted:** the hold no longer *immediately* drops a reroute that
then follows the cursor. It opens the menu; picking **Reroute** (the first entry) performs
exactly today's `insertRerouteOnEdge` at the hold point. The dot no longer trails the
cursor — it lands where you held, and is the sole selection, so a drag right afterwards
moves it exactly as before.

## 3. The menu = the connection-drop menu, with a splice context

A new context-menu target:

```ts
| { type: 'link-splice'; origin: ConnectionOrigin; edgeId: string }
```

`origin` is resolved from the edge's **SOURCE output** via the existing
`getOriginPortInfo` (which already walks reroutes and dynamic ports). Everything else is
reuse, not a clone:

| machinery | how it is reached |
|---|---|
| the item list + compatibility filter | `dropMenuItems` accepts the new target type; `origin.kind === 'output'` ⇒ the **Reroute** entry is offered exactly as on a connection drop |
| search box, ↑/↓ wrap, Enter, Esc, re-anchor-on-filter | `renderQuickAddSearch` verbatim |
| commit | `commitDropMenuItem` gains ONE branch |
| open/close discipline | the single `contextMenu` state; outside-pointerdown + Esc close it; `suppressNextEditorClickRef` stops the hold's own pointerup closing it |

**The plain connection-drop path is byte-behaviour-identical** — the new target type is
additive at every site.

## 4. Splice semantics

Picking a node **N** for the link `S.out ─► T.in`:

1. **ONE** `pushCurrentSnapshot()` — so Ctrl+Z restores the original edge *and* removes the
   node in a single step.
2. Create N at the hold point (`y` offset by `estimateNewNodePortY` so its incoming port
   lands on the wire).
3. `S.out ──► N.<in>` where `<in>` = `pickCompatiblePort(def, origin, resolvedCfg)` — **the
   exact rule `addNodeAndConnect` already uses** for the connection-drop menu.
4. **Remove the original edge** `S.out ─► T.in`.
5. If N has an output compatible with **T's input port**, wire `N.<out> ──► T.in`. The
   compatible-output search is the SAME `pickCompatiblePort`, called with a
   `ConnectionOrigin` built for the CONSUMER (`kind: 'input'`) — so `portsCompatible`
   applies the identical category / dataType / isArray / **composite** (vector, color) rules
   the editor enforces everywhere, in the correct source↔target orientation.
   *Flow edges:* `def.ports` lists `next` (DONE/NEXT) **before** the branch ports, so
   `candidates[0]` is the pass-through continuation — `do → N`, `N.next → old target`,
   which is the documented flow-pass-through semantics.
6. **No compatible output ⇒ the downstream is left unwired** (the original edge is still
   gone — the user asked for that). The node sits spliced in on the input side only; no
   dangling handle, no crash.

Steps 2–5 are ONE `setNodes` + ONE `setEdges` + ONE `scheduleSync`.

**Why no cycle/duplicate check is needed:** N is brand new, so `S→N` and `N→T` cannot
duplicate an existing edge, and `N→T` can only close a cycle if `T` could already reach `S`
— which the pre-existing `S→T` edge rules out. The freed value input is single-occupancy
again because the original edge is removed in the same updater.

## 5. Edge kinds & shapes covered

- **value** edges (the headline case) and **flow** edges.
- an edge whose **source is a reroute** — `getOriginPortInfo` has a reroute branch, so the
  origin carries the relayed category/dataType.
- an edge into a **macro instance** port — `getOriginPortInfo` returns `null` for a macro's
  dynamic port, so the consumer origin falls back to the handle's own category with
  `dataType: undefined` (= `any`), the editor's permissive default. Never a crash.
- **composite** (vector / color) edges — the composite rules live in `portsCompatible`, so
  a vector link only offers vector-capable nodes and only auto-wires a vector-typed output.
- a **stale edge** (deleted / undone while the menu was open) ⇒ the commit is a no-op that
  just closes the menu; no snapshot is pushed.

## 6. DEV hook

React Flow edges cannot be driven by synthetic pointer events, so — the
`__openConnectionDropMenu` precedent —

```js
window.__openLinkSpliceMenu(edgeId, clientX, clientY)   // DEV only
```

opens the splice menu for an edge, letting a browser-eval test drive the whole
menu + splice path.

## 7. Docs

- CLAUDE.md "Reroute Links" — the gesture now opens the menu; Reroute is one entry.
- HelpView — the hold-to-reroute sentence becomes hold-to-splice.

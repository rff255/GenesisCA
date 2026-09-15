# Plan — Pan with the right button WHILE dragging a wire

**Scope: editor layer only.** One effect in `GraphEditor.tsx` (+ a Help sentence). ZERO compiler
impact — nothing under `src/modeler/vpl/compiler/` changes, no schema field, no worker message.

Illustrated: [PLAN_CONNECTION_DRAG_PAN.html](PLAN_CONNECTION_DRAG_PAN.html). Status: **DELIVERED**
(2026-09-14, branch `follow-ups`).

---

## 1. The gap

Connecting two nodes that are far apart. The user's ask (verbatim):

> when trying to connect two nodes that are very far away, the user should be able to start the
> port LMB click-drag, then zoom out (possible today), then while still holding the LMB, right
> click and drag to pan the canvas around, until they reach the other node they will connect,
> when they can finally put the cursor on top of the consumer port and release LMB. nowadays if
> I try doing that, the RMB drag doesn't pan, and I get a context menu. We don't need a context
> menu by RMB while dragging a port, since we already offer that if the user drag a port and
> release in the canvas.

Two things went wrong today, and a third was silent:

1. **No pan.** React Flow's pan/zoom filter (`createFilter` in `@xyflow/system`) returns `false` for
   every non-wheel event while `connectionInProgress` — a d3-zoom gesture never starts. The wheel is
   let through, which is why zooming out already worked.
2. **A context menu.** With d3 out of the way the right press fell through to `contextmenu`, which
   `onPaneContextMenu` / `onNodeContextMenu` turn into our menu.
3. **The wire was dropped.** `XYHandle` ends the connection on ANY document `mouseup` — it never reads
   `event.button` — so releasing the right button ended the drag before the user reached the other node.

## 2. The gesture

```
LMB-press on a port ──► wire follows the cursor (unchanged)
   │
   ├─ wheel ─────────────────────────► zoom (unchanged — the filter lets wheel through)
   │
   ├─ RMB-press ─┬─ move ────────────► ★ PAN by the pointer delta; the wire keeps following
   │             └─ RMB-release ──────► ★ nothing: no menu, the wire is STILL held
   │
   └─ LMB-release ─┬─ on a port ──────► connect (unchanged)
                   └─ on the canvas ──► the connection-drop menu (unchanged: Reroute / add-and-connect)
```

## 3. The mechanism — one effect, four listeners

| listener | phase | what it does |
|---|---|---|
| wrapper `mousedown` | capture | `button === 2` while `isConnectingGlobal` ⇒ start the pan (remember the pointer), arm `suppressMenu`, `stopPropagation` |
| document `mousemove` | capture | while panning ⇒ `store.panBy({ dx, dy })` — a DELTA, so React Flow's own edge auto-pan composes with it |
| document `mouseup` | capture | `button === 2` while a wire is held ⇒ end the pan and `stopPropagation`, so XYHandle's bubble-phase `mouseup` never sees the right button |
| wrapper `contextmenu` | capture | armed, or a wire still held ⇒ `preventDefault` + `stopPropagation`; the flag is consumed here, and any later press clears a stale one |

**Mouse events, not pointer events — load-bearing.** A second button pressed while the first is held is
a *chord*: the Pointer Events spec fires NO `pointerdown` / `pointerup` for it (only a `pointermove`
whose `button` names the changed button), while the compatibility `mousedown` / `mouseup` fire per
button. XYHandle tracks the wire on `mousemove` / `mouseup` for the same reason.

**What is untouched:** a right-drag with no wire held still pans through d3 (the wrapper handler
returns early unless `isConnectingGlobal`); a right-click with no wire held still opens the menu;
the left release completes or drops the connection exactly as before; the RMB-through-edges
re-dispatch and the group-body box-select are pointer-event handlers and never see a chord.

## 4. Verification

Synthetic, in the dev server (the Handle's own React `onMouseDown` starts a real XYHandle drag; the
chord is real `mousedown` / `mousemove` / `mouseup` / `contextmenu` events, which React Flow's
document listeners accept): the connection stays `inProgress` across the right press, the pan moves
the viewport by exactly the pointer delta, the `contextmenu` is `defaultPrevented` and no
`[role="menu"]` appears, and the left release on a flow input still creates the edge — with a
control run of the same left-only gesture producing the same edge. Real-mouse checks of the
unchanged paths: a plain right-click still opens the canvas menu.

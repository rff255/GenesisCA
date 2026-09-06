# Brainstorm — see-through node canvas (edit the model while it plays)

**Status: brainstorm, no code.** Illustrated companion: [BRAINSTORM_SEE_THROUGH_CANVAS.html](BRAINSTORM_SEE_THROUGH_CANVAS.html) (live mockups — the board behind each mockup is a real Game of Life running in the page; Option A has a working dim slider + reach-through toggle).

## The idea
Blender keeps a live render behind (or beside) its node editors so every edit is seen landing. GenesisCA has both halves — a node editor and a simulator that soft-recompiles on every graph edit while keeping the grid — but they are mutually exclusive: switching to the Modeler unmounts the simulator UI and auto-pauses the run. The missing piece is only *seeing* the run while the graph is on screen, plus deciding who owns the pointer and the keyboard.

## What already exists (why this is cheap)
- `SimulatorView` is always mounted (hidden by `display:none`); its worker survives tab switches.
- A graph edit → 100 ms `scheduleSync` → `SET_GRAPH` → `useEffect([model])` → **soft recompile that preserves the grid** (structural edits force a reinit).
- Every GPU display path presents into a real DOM canvas the browser composites — stacking a graph over it is CSS z-order.
- Direct-render canvases already re-attach on a container resize (a splitter drag works today).

## Three layouts

| | A · Backdrop overlay | B · Split workspace | C · Live window (PiP) |
|---|---|---|---|
| Look | sim full-bleed behind a translucent graph pane (dim slider) | graph + full simulator viewport side by side / stacked, draggable splitter | small floating viewport over the graph; pop-out to an OS window via Document Picture-in-Picture |
| Interact with the board | through a modifier (hold Alt = "reach through": graph fades, gestures go to the sim) | directly, no arbitration | view-only; click switches tabs |
| Strength | the Blender "feel the edit land" look | cheapest, most legible, no input conflicts | multi-monitor |
| Weakness | two surfaces, one pointer; translucent full-viewport layer over a 60 fps canvas | half the width for the graph | weakest cause→effect feel; Chromium-only pop-out |
| Size | M | S–M | M |

**Recommendation:** build **B** as the base and make **A a layout setting on top of it** — one *Live* mode with a knob *Split right · Split bottom · Overlay*. Overlay = Split with the divider pushed to the edge and the graph pane's fill turned to glass; same two mounted views, same transport bar. Input arbitration (reach-through, focus owner) is then scoped to Overlay and can ship later. C's pop-out is a follow-up on the same mounted viewport; its in-page floating form could be skipped.

## Mechanics shared by every option
1. **Last-good-rule semantics.** A half-wired graph compiles with errors many times a minute; the run must keep the previous compiled function, show the amber `!` on the node + a small "● stale" state on the transport chip, never the red stop-everything banner (which stays for the Simulator tab).
2. **Apply policy.** *Auto (100 ms)* like Blender, or *On demand* (chip turns "● pending", Ctrl+Enter applies) for slow compiles and atomic multi-node edits. Stretch the debounce to ~400 ms while the pointer is down.
3. **Structural edits don't silently reset.** `needsFullInit` edits (new attribute, dims, capability profile) become a prompt on the chip ("Rebuild needed · board will re-seed · Apply / Later"), so N edits cost one reset. `resetRestoresBoard` already answers what comes back.
4. **Mounting both views.** Render both with a "shown" flag distinct from "active tab" so the simulator's auto-pause doesn't fire and `draw()` keeps running; Live gives the graph the modeler's panels and hides the simulator's (brush + indicators become popovers from the viewport bar).
5. **Keyboard owner.** Focused surface (last click/hover, visible focus ring) gets Space/Esc/Ctrl+Z; **Enter is global play/pause** (unless a field/menu has focus); Esc never resets in Live; Alt-hold = reach-through in Overlay only.
6. **Perf guards.** Default FPS cap 30 in Live; skip the blit (not the step) during a node drag.
7. **Determinism.** A mid-run recompile is a new rule from generation N; the Overseer must refuse to run while Live is on (same mutual exclusion it has with manual play).

## Open questions
- Third top-level mode (Modeler · Simulator · Live) vs a toggle inside the Modeler?
- Should sparse Agents draw over the graph even at full dim, unlike the dense cell grid?
- Macro scope: breadcrumb + boundary nodes take vertical space the overlay could use.
- Standalone `.html` export: almost certainly out (it ships the simulator only).

Next step, if greenlit: an Impact Map (App tab mounting, SimulatorView `visible` semantics, ModelerView/GraphEditor layout containers, keyboard handlers in both views, the compile-error banner path, Overseer mutual exclusion).

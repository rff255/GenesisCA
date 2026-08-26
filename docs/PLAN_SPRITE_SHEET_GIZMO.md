# Sprite-sheet FIRST-CELL gizmo + first-frame previews

Two coupled changes to the sprite-sheet workflow. Illustrated: [PLAN_SPRITE_SHEET_GIZMO.html](PLAN_SPRITE_SHEET_GIZMO.html).

**Scope: presentation + decode geometry only.** Nothing under `src/modeler/vpl/compiler/`,
no `sim.worker.ts`, no engine file — zero compiler impact by construction.

---

## A — a draggable / scalable FIRST-CELL rectangle in the gridding dialog

Today [SpriteSheetDialog.tsx](../src/components/SpriteSheetDialog.tsx) controls the grid ONLY
through NumberFields (cols / rows / marginX / marginY / spacingX / spacingY). Aligning a grid to a
real sheet by typing six numbers is guesswork. The Map Image to Cells dialog already solved this
shape with its orange **cell reference** square; the sprite dialog gets the same gizmo over the
grid's FIRST CELL (row-major cell 0).

| gesture | writes |
|---|---|
| drag the rectangle's **body** | `marginX` / `marginY` — the grid ORIGIN moves |
| drag its **corner handle** | `cellW` / `cellH` — the CELL SIZE scales |
| **click** it without moving | toggles cell 0 in the selection, exactly as before |

The NumberFields REMAIN and stay in sync both ways (the user asked for this explicitly): a drag
updates them live, typing into them moves/resizes the rectangle.

### THE SCHEMA PROBLEM, and the additive answer

Cell size is currently **DERIVED**, not stored ([spriteSheet.ts](../src/model/spriteSheet.ts)):

```
cellW = max(1, floor((imgW − marginX − (cols−1)·spacingX) / cols))
```

Two consequences: a smoothly scalable rectangle cannot be expressed through integer cols/rows
alone, and the derived size is **locked to the full image width** — a sheet with trailing dead
space on the right or bottom cannot be gridded correctly today at all.

So `SpriteSheetSpec` gains **optional `cellW?` / `cellH?`**:

- **ABSENT ⇒ derived exactly as today, byte-for-byte.** Every existing `.gcaproj`, and every
  sheet authored without touching the gizmo, slices identically. Standard additive-schema
  pattern; **no migration**.
- Present ⇒ `sheetGrid` uses the explicit size, still `max(1, floor(...))`-sanitised.
- **THE FOLD RULE** (`sheetWithCellSize`, mirroring `sheetWithFrames`): when a committed explicit
  size EQUALS the derived one, the keys are **deleted** — so a gizmo drag that lands back on the
  derived geometry keeps the legacy record shape. Applied once, at Apply.

Everything downstream already routes through `sheetGrid` / `sheetCellRect` / `sheetFrameRects`
(the dialog overlay, the decoder's `sliceSheet`, the harness), so extending `sheetGrid` is the
ONE edit that propagates. `spriteDecodeKey` serialises `sheet` wholesale, so a cellW edit
re-decodes and reaches the CPU overlay, gl3d and the 2D GPU atlas with zero plumbing.

### Cells partially outside the image

Explicit sizes make this reachable (it was not before). `createImageBitmap(bmp, x, y, w, h)` crops
with **transparent padding** outside the source, so such a frame decodes to the requested size with
transparent edges — the honest result. The overlay draws the grid as specified, including the part
hanging off the image, so the user can SEE the overhang rather than wonder why a frame is clipped.

### Interaction rules kept intact

- Hit priority: **first-cell handle → first-cell body → the existing cell-toggle / pan.**
- A press on the body is **PROVISIONAL**: it becomes a move only past `GIZMO_DRAG_PX`; released
  under that threshold it toggles cell 0. Without this, cell 0 would become the one cell you could
  never click into the animation.
- **`setPointerCapture` only for a real drag, and wrapped in try/catch** — the documented trap is
  that capturing on every press makes the canvas undrivable from synthetic pointer events. A drag
  wants capture (the pointer leaves the canvas); a plain press must not take it, and a synthetic
  pointerId must not throw.
- The viewport stays **FIXED-size** (the documented layout rule — sizing it to the image causes the
  drag-feedback-loop reflow).
- Drags write local state live (smooth) and commit **integer-rounded** values against the drag's
  own start values, so dragging back and forth cannot drift. Margins clamp ≥ 0, cell size ≥ 1.

---

## B — sprite previews show the FIRST FRAME, not the whole sheet

A sheet asset currently renders the FULL sheet image at three sites in
[MappingsPanelContent.tsx](../src/modeler/panels/MappingsPanelContent.tsx):

| site | before | after |
|---|---|---|
| list-row thumbnail (24 px) | whole sheet, unreadably small | frame 1 of the animation |
| detail-editor image (48 px) | whole sheet | frame 1 |
| `SpriteBgPicker` (chroma key) | whole sheet | frame 1 — you pick the key colour off REAL frame pixels |

"Frame 1" is `sheetFrameRects(sheet, w, h)[0]` — the first cell of the ANIMATION SELECTION, not
cell 0, so a hand-picked selection previews what actually plays first.

One shared **`SpriteFramePreview`** component serves all three (never three ad-hoc crops). A
`frames` sequence asset uses `frames[0]`; a plain single image is unchanged; an animated GIF/WebP
keeps animating in an `<img>` (it is not a sheet). Chroma-key processing is deliberately NOT
applied in these previews — the picker in particular must show the raw key colour.

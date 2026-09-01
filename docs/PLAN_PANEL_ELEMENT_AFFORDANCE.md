# Panel element rows — making model elements read as interactable objects

**Status:** plan + illustrated mockup (`PLAN_PANEL_ELEMENT_AFFORDANCE.html`), then implemented.
**Scope:** UI/CSS layer only — the shared `PanelContent.module.css` primitives + a class flag in
the panel TSX. Zero behaviour change: click-to-select, the drag payloads, the reorder handles and
the auto-scroll are untouched, and nothing in a compiler, the worker or the engine is opened.

---

## 1. The problem

Every first-class model element the user can author lives as a row in a Modeler panel:

| panel | rows |
|---|---|
| Attributes | cell / agent attributes · model attributes · **bond attributes** · Local Variables |
| Neighborhoods | neighbourhoods |
| Mappings | cell A→C · cell C→A · agent A→C · agent C→A · **sprites** |
| Properties → Indicators | indicators |
| Variegated | **face patterns** |

Ten of those row kinds are **draggable onto the graph canvas** (`application/genesisca-model-element`
→ the drop menu offers the nodes that consume that element and pre-fills its id). That is one of the
fastest ways to build a graph in the whole app — and **nothing on the row says so.**

At rest a row is `background: var(--color-overlay-row)` (a 2.5–3 % white wash) with no border and
`cursor: pointer`. On both shipped themes that is a *tint*, not an edge: the rows read as a list of
text lines, not as a stack of grabbable objects. The user's report is exactly this — *"the
attributes … have a bit of a low profile inside the panel, when they are actually very important"*.

There is also a latent defect in the same place: `.listItemSelected` adds `border: 1px solid` while
the unselected row has **no border at all**, so selecting a row **shifts the whole list by 2px**.

---

## 2. Directions considered

### A — Grip glyph on hover *(rejected)*
Reveal a `⠿` drag grip at the row's left edge on hover, leave the row as it is otherwise.

Cheap and literal, but it fails the actual complaint: the problem is the **resting** state, and a
hover-only affordance is invisible until the pointer is already on the row. It also puts a
six-dot glyph ~4 px from the existing **`⋮⋮` reorder handle** on the right of the same row — two
dotted grips on one row, meaning two completely different gestures (reorder within the list vs.
drag out to the canvas). That is the confusion the brief explicitly warns against.

### B — Kind-coloured chip / card per element *(rejected)*
Render each element as a coloured pill or a two-line card keyed by kind (attribute / mapping /
indicator …).

Gaudy for a professional tool, and **redundant**: the kind is already carried by
`.listItemBadge` — `A→C` / `C→A` on mappings, the type name on attributes, the cell count on
neighbourhoods, `4f` on sprites — plus a 24 px thumbnail on sprite rows. Adding a second per-kind
colour code would be noise, and taller cards would halve how many attributes fit in a panel.

### C — Object rows with a drag rail *(chosen)*
Two independent layers, applied through the shared primitives:

1. **Every row becomes an object.** A real 1 px outline + a firmer surface, so the row reads as a
   discrete thing at rest rather than as a line of text. This also fixes the 2 px selection jitter.
2. **Draggable rows additionally get a drag rail + `cursor: grab`.** A 3 px bar down the row's
   leading edge — a dim neutral at rest, the **accent** on hover — plus `cursor: grab`, which is
   the strongest and cheapest "you can pick this up" signal a pointer can carry, and one no glyph
   can beat. Non-draggable rows (bond attributes, face patterns, the input-parameter editor row)
   keep `cursor: pointer` and get **no rail**, so the rail means exactly one thing.

Chosen because it answers the resting-state complaint (layer 1), states the *specific* affordance
the user is missing (layer 2), needs no second glyph next to `⋮⋮`, costs zero layout (the rail is a
pseudo-element, so it neither shifts text nor collides with the `box-shadow`-based drop
indicators), and lands entirely in the shared primitives so all eight lists inherit it at once.

---

## 3. The design

```
┌─────────────────────────────────────────────┐
│▍ alive                        Binary   ⋮⋮   │   draggable, at rest
└─────────────────────────────────────────────┘   rail: dim neutral · cursor: grab
┌─────────────────────────────────────────────┐
│▍ alive                        Binary   ⋮⋮   │   draggable, hover
└─────────────────────────────────────────────┘   rail: ACCENT · border: accent-strong
┌─────────────────────────────────────────────┐
│▍ alive                        Binary   ⋮⋮   │   selected
└─────────────────────────────────────────────┘   accent border + accent-soft fill
┌─────────────────────────────────────────────┐
│  strength                     Decimal  ⋮⋮   │   NOT draggable (bond attribute)
└─────────────────────────────────────────────┘   no rail · cursor: pointer
```

### ⚠ The border token is `--color-border`, **not** `--color-widget-border`
This is the trap this feature had to route around, and it is the same one the `.dragHandle` comment
already records for glyph colour. The two themes need **opposite** edges:

| | panel surface | `--color-widget-border` | `--color-border` |
|---|---|---|---|
| Nocturne | `#16181d` | `#262a31` — lighter, reads | `#2a2d35` — lighter, reads |
| Blender | `#3d3d3d` | `#3a3a3a` — **≈ the surface, invisible** | `#1d1d1d` — darker, reads |

`--color-widget-border` is the canonical *input/button* outline, and its own token comment says it
is "almost identical to panel bg — outlines virtually disappear" on Blender. A row outlined with it
would look correct on Nocturne and stay exactly as low-profile as today on Blender, i.e. it would
fix the bug in one theme only. **`--color-border` is the cross-theme "this is an edge" token**:
lighter than the surface on Nocturne (which is near-black, so definition comes from above) and
darker on Blender (whose own idiom is dark separator lines). It reads on both.

### The rail
An absolutely-positioned `::before` on the row (`.listItem` gains `position: relative`), inset from
the rounded corners, 3 px wide.

* **`box-shadow` is not an option**: `.dropIndicatorBefore` / `.dropIndicatorAfter` already own the
  row's `box-shadow` during a reorder drag, and a second rule setting `box-shadow` would replace
  theirs outright rather than composing — the drop indicator would vanish on exactly the rows that
  can be reordered.
* **`border-left` is not an option** either: it would reflow the row's content by 3 px the moment
  the rail appears, and the rail exists on every draggable row at rest anyway.

Rest colour is `--color-text-muted` (Nocturne `#6f6c64`, Blender `#898989`) — legible on both
surfaces, subordinate to the row's name. Hover promotes it to `--color-accent`.

### Selected must still outrank a plain row
Now that unselected rows carry `--color-border`, the selected border is promoted from
`--color-accent-strong` (a 0.42–0.45 alpha wash) to the **solid `--color-accent`**, keeping the
`--color-accent-soft` fill. A selected draggable row's rail also goes full accent, so "selected"
and "grabbable" compose instead of competing.

### The one-time hint
All ten draggable row kinds **already** carry a `title` ("Drag to canvas to add a node that uses
'…'") — verified row by row. No TSX change is needed for the hint; it simply becomes discoverable
now that the row advertises that it is draggable at all.

---

## 4. Implementation

**`src/modeler/panels/PanelContent.module.css`**
* `.listItem` — add `position: relative`, `border: 1px solid var(--color-border)`, and lift the
  resting fill slightly; transition `border-color` alongside `background`.
* `.listItemSelected` — `border-color: var(--color-accent)` (no longer re-declares `border`, so no
  width change).
* **`.listItemDraggable`** *(new)* — `cursor: grab`; `::before` rail; hover promotes the rail and
  the border; `:active { cursor: grabbing }`.

**Panel TSX** — add `styles.listItemDraggable` to the `className` of the ten rows that already
carry `draggable` + `onDragStart`. Nothing else changes.

| file | rows getting the class | rows correctly NOT getting it |
|---|---|---|
| `AttributesPanelContent.tsx` | cell/agent attributes · model attributes | **bond attributes** |
| `VariablesPanelSection.tsx` | local variables | — |
| `NeighborhoodsPanelContent.tsx` | neighbourhoods | — |
| `MappingsPanelContent.tsx` | cell A→C · cell C→A · agent A→C · agent C→A · sprites | **the input-parameter editor row** |
| `IndicatorsPanelSection.tsx` | indicators | — |
| `VariegatedCellsPanelContent.tsx` | — | **face patterns** |

**Out of scope:** the simulator's **preset** rows. They are not canvas-draggable and they do not use
this stylesheet at all — `SimulatorView.module.css` carries its own copy of `.dragHandle` (kept in
lockstep by a comment) and its own row styling, so they are untouched by construction.

---

## 5. Verification

* Both themes, computed styles read off the live DOM: the border, the rail's rest/hover colour and
  `cursor: grab` on a draggable row; **no `::before` rail and `cursor: pointer`** on a bond
  attribute and a face pattern.
* Every panel walked: Attributes (all four sections), Neighborhoods, Mappings (all five sections),
  Properties → Indicators, Variegated.
* Selection no longer shifts the list (the row's `offsetHeight`/`offsetTop` are identical selected
  and unselected).
* Drag-to-canvas still spawns the pre-filled node; reorder by `⋮⋮` still works; the drop indicator
  still draws during a reorder drag on a rail-bearing row.
* `npx tsc -p tsconfig.app.json --noEmit` + `npm run build`.

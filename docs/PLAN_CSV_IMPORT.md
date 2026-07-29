# PLAN — CSV Import (agents + CA grid)

Import tabular data into a running simulation, two flavours behind ONE dialog:

- **Agents** — each CSV **row is one agent**; columns carry position / velocity /
  radius / agent-attribute values.
- **Grid** — the CSV **IS the board**: each CSV row is a grid row, each field a
  grid column, and every value is written into ONE chosen cell attribute.

This is a scientific-workflow feature: the whole point is that the value that sat
in the file is the value that ends up in the store. Correctness of the mapping —
not the dialog — is the deliverable.

---

## 1. Why one dialog, two modes

The `ImageMappingDialog` precedent ("Map Image to Cells") is a modal card with
setup on the left, a live preview on the right, and Apply/Cancel. CSV gets the
same shape (`CsvImportDialog`): a **preview table** on the left, the **target +
mapping controls** on the right.

A CSV file carries no hint about which layer it targets, so guessing in the drop
handler would be wrong half the time. Instead the dialog owns a **Target** switch
(Agents / Grid):

| Model topology | Target switch |
| --- | --- |
| agents only | hidden, fixed to **Agents** |
| grid only | hidden, fixed to **Grid** |
| both layers | shown; default from the header heuristic (below) |

**Both-layer default (decision):** default to **Agents** when a header row was
detected, else **Grid**. Rationale — a header names FIELDS, which is the agent
shape (`x,y,species`); a headerless rectangular block of values is the board
shape. One click flips it, and the dialog states which it picked.

---

## 2. The parser (`src/simulator/csvImport.ts`, no new dependency)

A small RFC-4180 parser, pure + unit-verified (`scripts/test-csv-import.mjs`):

- quoted fields, `""` escapes inside quotes, embedded commas / newlines
- CRLF and LF, a trailing newline ignored (no phantom last row)
- a UTF-8 BOM stripped
- **delimiter auto-detection** over `,` `;` `\t` (the one giving the most
  consistent field count across the first lines wins; ties → `,`), user-overridable

**Header detection (decision):** the first row is a header iff it contains **no
numeric field** AND at least one LATER row **does** contain a numeric field.
That accepts `x,y,radius` over numeric rows, and correctly REJECTS a grid of tag
NAMES (all-non-numeric everywhere → no header, the whole file is data). A
checkbox overrides it either way.

---

## 3. Flavour A — Agents

### Column mapping

Every column gets a `<select>` target:

```
ignore | x | y | z | vx | vy | vz | radius | <agent attribute> | <vector attr>.x/.y/.z
```

- `z` / `vz` and `.z` components are offered only in a 3D model.
- A **vector** agent attribute contributes one target PER COMPONENT
  (`facing.x`, `facing.y`[, `.z`]) — the store carries the `_vx/_vy/_vz`
  component attributes, never a packed vector, so the columns map straight onto
  them (`vectorComponentIds`).
- **Auto-map by name** (case-insensitive, header only): `x`/`y`/`z`, `vx`/`vy`/`vz`
  (also `velocity_x`…), `radius`/`r`, then exact agent-attribute NAME matches, then
  `name.x`-style vector components. Everything else → ignore. Fully overridable.
- Without a header: all columns → ignore except the first two → `x`, `y`.

### Value decoding (per target type)

| target | accepted | on failure |
| --- | --- | --- |
| x/y/z/vx/vy/vz/radius | any finite number | row SKIPPED if x or y unparseable; otherwise the field is dropped |
| integer / float attr | any finite number (integer rounds) | attribute default, counted |
| bool attr | `1/0`, `true/false`, `yes/no`, `t/f` (case-insensitive) | attribute default, counted |
| tag attr | the option NAME (case-insensitive exact) **or** a numeric index | attribute default, counted |
| vector component | any finite number | 0, counted |

Everything is funnelled into the worker as `{attrId, value}` sets via the existing
`encodeAttrValue` encoding — so a tag lands as its INDEX and a bool as 1/0,
exactly like the manual brush.

### Options

- **Replace population** (kill all first) vs **Append**.
- Out-of-bounds positions → **torus-wrap** when the model's boundary is torus,
  else clamp. (The worker already does this inside `pasteAgents`; the dialog only
  reports how many rows will be affected.)
- A **row limit** guard against `maxAgents` (overflow → import what fits; the
  worker's existing `agentOverflow` notice surfaces the rest).

### The apply seam — `pasteAgents` (existing, unchanged)

`pasteAgents` already takes PER-AGENT specs
(`{x,y,z?,radius?,vx?,vy?,vz?,sets?}`), allocates through the engine primitives
(`allocAgentSlot` / `initAgentSlot` / `applyAgentSets`), wraps/clamps per `torus`,
reports overflow, re-runs the agent colour pass, and sits in
`AGENT_GPU_DEFER_TYPES` — so it is deferred during a GPU step batch and
invalidates the resident GPU copy. **That makes CSV agent import
compile-target-agnostic BY CONSTRUCTION** (JS / WASM / WebGPU agent targets).

Replace uses the existing `clearAgents` message first. **No new agent worker
message is needed.**

---

## 4. Flavour B — CA grid

### Row/column convention (decision, stated in the dialog)

> **CSV rows = grid rows (height). CSV fields = grid columns (width).**

A 12-line × 9-field CSV produces a **9 wide × 12 tall** grid. This is what the
file looks like in a spreadsheet, so what you see is what you get. Ragged rows are
padded with the attribute default up to the widest row (and counted).

### Target attribute

One `<select>` over the model's CELL attributes (model attributes excluded —
they are not per-cell). Vector cell attributes are offered per component. The
same per-type decoding table as Flavour A applies; unparseable → the attribute
default, counted and reported.

### Fit

- **Resize grid to the CSV** (default): `initWorkerWithDimensions(cols, rows)`
  then apply once the worker reports its first `stepped` — the exact
  `pendingImageImport` / `pendingManualImport` pattern.
- **Keep grid** (requires `cols === W && rows === H`): apply immediately.

**3D:** a 2D table cannot express a volume, so a 3D model gets a **Layer**
selector and the CSV is written into that one layer. Resize changes W×H and keeps
the current depth. (Documented in the dialog.)

### The apply seam — ONE new worker message

`paintManual` carries one SHARED `sets` for all cells (wrong shape: we need a
different value per cell) and `importImage` is colour-mapping-based. So:

```ts
interface ImportGridValuesMsg {
  type: 'importGridValues';
  attrId: string;
  width: number; height: number;   // the CSV block's dims
  layer?: number;                  // 3D target layer (default 0)
  values: Float64Array;            // row-major, length width*height (transferred)
  activeViewer: string;
}
```

Handler (modelled on `importImage` / `paintManual`):

1. If WebGPU owns the attrs (`gpuOwnsAttrs` after a Play), **read the attrs back
   to CPU first** — a partial write plus `uploadAttrs` would otherwise push a
   stale CPU mirror of the OTHER attributes back onto the GPU.
2. Write `readAttrs[attrId][idx] = values[r*width+c]` for every in-bounds cell
   (`cellIndexOf(layer,row,col)`); in **sync** mode also write `writeAttrs` (the
   `paintManual` two-buffer discipline).
3. Display refresh: WebGPU → `uploadAttrs` + `uploadActiveViewer` +
   `refreshColorsAfterInputWebGPU` + `finalizeStepWebGPU` → `sendColors`;
   otherwise `refreshColorsAfterInputJS()` + `sendColors()`.

It joins the message sets that are deferred during a GPU agent batch and that
invalidate the GPU agent upload, exactly like `paint` / `writeRegion`.

---

## 5. Entry points

- **Buttons**: `Import CSV…` next to `Open Image` in the CA-grid brush block, and
  in the Agent Brush block for agent models. Both open the same dialog (with the
  target pre-selected).
- **Drag and drop**: `.csv` / `.tsv` in `App.tsx`'s `handleDroppedFile` →
  `genesis-open-csv-file` CustomEvent → SimulatorView (the exact
  `genesis-open-image-file` pattern).

---

## 6. Reporting (non-negotiable for a science feature)

The dialog shows a live summary computed from the actual parse, e.g.

```
142 rows · 3 unparseable values defaulted · 2 rows out of bounds (wrapped)
```

and lists the first few offending cells (`row 17, column "species": "gren"`). An
import never fails silently.

---

## 7. Overseer pairing (stretch — deferred if budget runs out)

Sketch: a session-scoped named CSV store (`csvStoreRef` in SimulatorView, filled
by the dialog with a user-given name), plus an overseer node `ovLoadAgentsCsv`
(config: store name, replace/append) compiling to `await O.loadAgentsCsv(name)`;
the runtime dep posts the SAME `pasteAgents`/`clearAgents` messages the dialog
does and awaits the ack. Seams named: `OVERSEER_UNIVERSAL_TYPES` (no — it is an
overseer node, `requirements: { overseer: true }`), `compiler/overseer/compile.ts`
action emit, `overseerRuntime.ts` deps, `ExperimentsPanel` untouched. Verified by
`scripts/test-overseer-compile.mjs` plus a browser run.

---

## 8. Milestones

1. Plan + illustrated mockup (this doc + `PLAN_CSV_IMPORT.html`).
2. `csvImport.ts` + `scripts/test-csv-import.mjs`.
3. Flavour A end-to-end + browser verification (2D, 3D, WebGPU agent target).
4. Flavour B end-to-end + browser verification (resize, keep-grid, WebGPU grid
   after a Play).
5. Docs (Help / README / CLAUDE.md / NODES_REFERENCE if nodes change) + the
   harness sweep.

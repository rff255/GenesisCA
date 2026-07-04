# PLAN — Agent Brush parity (shapes · single/area · Add/Remove rename · Edit mode)

**Branch:** `polish_agents`
**Illustrated mockup:** [PLAN_AGENT_BRUSH_PARITY.html](PLAN_AGENT_BRUSH_PARITY.html)
**Scope decisions (locked with the user):**
- **Area move** = *rigid group drag* — dragging carries every agent in the footprint by the same delta.
- **Edit scope** = *attributes + radius + velocity + position* (the full "all properties, including attributes").
- **3D** = ships in **both** the 2D canvas and the 3D voxel view together (project's 2D/3D-parity rule).

---

## 1. Goal (verbatim request)

> Agent brush should have the same brush styles as the CA Grid (square, circle, ring, line); and allow as many similar shortcuts as possible/compatible (e.g. Ctrl+LMB drag for changing the radius). It should also have a "single"/"area" mode switch, where *single* affects one agent (add/remove/move…) while *area* affects the whole footprint (like today, but some actions like move don't quite apply on the whole area). Rename "Seed" → "Add" and "kill" → "remove". And a way to edit all the properties (including attributes) of an agent — perhaps an "edit" mode that reuses the "Seed" UI, where the user selects which properties to overwrite.

---

## 2. What already exists (reuse map, with anchors)

| Capability | Where | Reuse |
|---|---|---|
| Brush shapes `rect/circle/ring/line` | `BrushShape` [SimulatorView.tsx:54](../src/simulator/SimulatorView.tsx#L54), `brushShapeOffsets()` :61, `brushShapeOffsets3d()` :106, `lineStampCells()` :146, `cellSilhouetteEdges()` :175 | **Reuse verbatim** to build the agent footprint + cursor. |
| Ctrl+LMB-drag resize (shape-adaptive) | onDown snapshot :4771, onMove math :4993 | **Reuse the state machine**; add a `brushTarget==='agents'` branch (see §7 gotcha #1). |
| Cell-footprint → plane projection (3D) | `mapStampToPlane()` :4357 | **Reuse** for the 3D agent footprint. |
| `ManualBrushPanel` (checkbox + widget rows) | [ManualBrushPanel.tsx:37](../src/simulator/ManualBrushPanel.tsx#L37) | **Reuse a 3rd time** for Edit; synthetic geometry rows are extra `Attribute`-shaped entries. |
| Edit-live-agent-attrs primitive | worker `paintAgents` [sim.worker.ts:5247](../src/simulator/engine/sim.worker.ts#L5247) → `applyAgentSets` :858 | **Reuse + extend** with optional geometry. |
| Prefill from a live agent | worker `getAgentState` :5287 (returns `attrs`, geometry, velocity) | **Reuse** for Edit prefill. |
| Group move | worker `moveAgents` :5316 already accepts a `moves[]` array + `xNext` discipline | **Reuse** for rigid group drag. |
| Agent seeding | `agentSeedPoints()` :4067 (2D disc), `agentSeedPoints3d()` :3119 (ball/flat) | Keep for circle/ball Add; add footprint-scatter for rect/ring/line. |
| 3D agent render + pick | `gl3d` sphere impostors, `pickAgent()` [gl3d.ts:851](../src/simulator/render/gl3d.ts#L851), `instanceToSlot()` :3103, `pickAgent3d()` :3246 | **Reuse** for 3D single-pick + membership. |

**Net:** the worker side is ~90% there. The bulk of the work is UI + client-side footprint/routing in `SimulatorView.tsx`, plus one small `paintAgents` extension for Edit geometry.

---

## 3. Mode model

Rename the internal ids and add `edit` (session-only state — `agentBrushMode` is **not** persisted, so no migration):

```ts
type AgentBrushMode = 'add' | 'remove' | 'move' | 'edit' | 'glue' | 'cut' | 'bond';
// was: 'seed' | 'kill' | 'move' | 'glue' | 'cut' | 'bond'
```

- `seed → add`, `kill → remove` at **every** comparison site (2D handler :4704, 3D handler :3410, tooltips, default state :861). The `killAgents` **worker message keeps its name** (internal). The `genesisca_agent_seed_v1:` **persistence key is unchanged** (a constant, not tied to the mode id — Add's seed-config survives).
- Button labels come from a display map so copy is decoupled from routing:
  ```ts
  const AGENT_MODE_LABEL = { add:'Add', remove:'Remove', move:'Move', edit:'Edit', glue:'Glue', cut:'Cut', bond:'Bond' };
  ```

*(Considered a pure label-map keeping ids `seed`/`kill`; chose the real rename for readability since `agentBrushMode` isn't persisted and every call site is inside one file.)*

---

## 4. Shapes for the agent brush

New agent-brush shape state mirroring the CA-grid brush (persisted in `genesisca_sim_settings`):

```
agentBrushShape : BrushShape          // 'rect' | 'circle' | 'ring' | 'line'  (default 'circle')
agentBrushW, agentBrushH              // rect
agentBrushRadius  (already exists)    // circle / ring radius
agentBrushRingWidth                   // ring band
agentBrushLineWidth                   // line thickness
```
+ hot-path refs for each, `agentLineAnchorRef` (2D) / `agentLine3dAnchorRef` (3D) for the two-click Line, and `agentStampCacheRef` (mirror of `stampCacheRef`).

**Footprint → agent membership** (the keystone helper):

```
agentFootprintCells(centerWorld) : Set<packedCell>
  = brushShapeOffsets(shape, W, H, radius, ringWidth)      // reuse CA-grid fn
      .map(off → floor(center)+off, torus-folded)          // reuse the mapStampToPlane wrap
  → Set keyed r*K+c   (K = a large stride, like cellSilhouetteEdges' 131072)

agentsInFootprint() : id[]
  = snapshot agents where Set.has(pack(floor(ay), floor(ax)))   // + torus fold near seam
```
This gives **rect / ring / line** agent membership for free and is shared by Remove-area, Edit-area, and the Move-area group collection.

**Add per shape:** circle keeps the even sunflower (`agentSeedPoints`); rect/ring/line scatter `round(density × coveredCells)` jittered points across the footprint's covered cells (density-consistent). Line uses `lineStampCells` as the covered region.

---

## 5. Single / Area

New shared toggle (persisted): `agentBrushScope : 'single' | 'area'` (default `'area'` — preserves today's Add/Remove feel). Shown for **Add / Remove / Move / Edit**; hidden for Glue/Cut (inherently two-agent) and Bond (inherently an area-scan) — those keep today's behavior.

### Behavior matrix

| Mode | **Single** | **Area** |
|---|---|---|
| **Add** | Place exactly **one** agent at the cursor (ignore shape/density) | Scatter agents across the shape footprint (today's seed, now shape-aware) |
| **Remove** | Remove the **one** nearest agent (`pickAgentAt`) | Remove **all** agents whose cell ∈ footprint |
| **Move** | Drag the **one** picked agent (today's move) | **Rigid group drag** — collect agents in footprint at pointer-down, translate all by the drag delta (`moveAgents` batch) |
| **Edit** | Click an agent → prefill panel from its live state → **Apply** writes to that agent | Click/drag footprint → stamp the checked overwrites onto **all** agents under it (live) |

**Line + Move**: a two-click line can't express a rigid drag, so when `mode==='move'` the Line shape falls back to single-agent move (noted in tooltip). Line + Add/Remove/Edit operate on the capsule region.

---

## 6. Edit mode (attributes + radius + velocity + position)

Reuses `ManualBrushPanel` with the model's `agentAttributes` **plus synthetic geometry rows** appended (they're just `Attribute`-shaped objects — the panel renders type-appropriate widgets and tracks `{enabled,value}`, agnostic to id meaning):

```
__geom_radius__  (float)
__geom_x__, __geom_y__ [, __geom_z__ in 3D]   (float — absolute position)
__geom_vx__, __geom_vy__ [, __geom_vz__ in 3D] (float — velocity, momentum models)
```

- **State/persistence:** `editAgentAttrs: ManualBrushModelState` + ref, merge-effect keyed off `agentAttrSig` (NOT `cellAttrSig` — gotcha #4), persisted under a new `genesisca_agent_edit_v1:` key. Geometry rows default `enabled:false`.
- **Prefill (Single):** on pick, `getAgentState(id)` → its `attrs` + geometry → `decodeAttrValue()` (new inverse of `encodeAttrValue`) fills the panel strings; the picked agent is highlighted as the edit target.
- **Flush:** iterate the panel — real attr ids → `sets: [{attrId,value}]` (via `encodeAttrValue`); `__geom_*` ids → a `geom` object. Post the **extended** `paintAgents`:
  ```ts
  { type:'paintAgents', ids, sets?, geom?:{radius?,x?,y?,z?,vx?,vy?,vz?}, torus?, activeViewer }
  ```
- **Single** posts `ids:[target]` on the **Apply** button; **Area** posts `ids: agentsInFootprint()` live on click/drag.

### Worker change (the only worker-protocol delta)

Extend the existing `paintAgents` handler ([sim.worker.ts:5247](../src/simulator/engine/sim.worker.ts#L5247)) — `sets` becomes optional, add `geom`/`torus`:
- attrs → `applyAgentSets` (unchanged);
- `geom.radius` → `radius[id]` **and** `targetRadius[id]` (so growth doesn't undo it);
- `geom.vx/vy/vz` → velocity (vz only when `worldDepth>1`);
- `geom.x/y/z` → position with the **`moveAgents` discipline** (write `x` **and** `xNext`, torus-wrap or clamp; z only in 3D).
Writes go through the same buffers under JS **and** wasmBacked/WebGPU-backed agents (baked-offset views — `moveAgents` already proves this), and `runAgentColorPass` already runs after, so all agent targets are covered with no per-target code.

---

## 7. Ctrl+LMB-drag resize (+ the latent bug)

**Bug today:** the resize gesture is gated only on `e.button===0 && e.ctrlKey` and reads/writes the **CA-grid** brush refs — so a Ctrl-drag while `brushTarget==='agents'` silently resizes the *hidden* cell brush. Fix = branch both the onDown snapshot (:4771) and the onMove math (:4993) on `brushTargetRef.current==='agents'`, reading/writing the **agent** shape state. The per-shape math (radius / radius+width / line-width / W+H) is identical. Mirror the same branch in the 3D resize path.

---

## 8. Cursor

- **Area scope:** the shape silhouette — reuse `cellSilhouetteEdges` + the negative-silhouette `difference`-composite render (the CA-grid cursor path), replacing the agent radius-ring-only draw at :1527. Rect/ring/line get proper outlines; Line shows its staged anchor + capsule preview.
- **Single scope:** the hovered-agent highlight ring (today's behavior) — the footprint is irrelevant when one agent is targeted.
- **3D:** reuse `mapStampToPlane` → gl3d's cell-highlight (`setHoverCells`, already used by the CA-grid 3D brush) for the area footprint; keep the billboard ring for the hovered/edit-target agent.

---

## 9. 2D ↔ 3D parity

Everything above is wired in **both** pointer handlers:
- **2D** canvas handler (:4704) — footprint via `agentFootprintCells`, cursor via silhouette.
- **3D** gl-canvas handler (:3410) — footprint via `mapStampToPlane` (+ volumetric ball/box for Add via `agentSeedPoints3d`), pick via `pickAgent3d`→`instanceToSlot` (through the `agentInstOrder` alpha-sort permutation — gotcha #3), group-move drags on the interaction plane, cursor via gl3d hover cells. Glue/Cut/Bond keep collapsing to the current 3D behavior.

---

## 10. Files changed

| File | Change |
|---|---|
| `src/model/attrValueEncoding.ts` | **Add** `decodeAttrValue(attr, numeric): string` (inverse of `encodeAttrValue`). |
| `src/simulator/engine/sim.worker.ts` | **Extend** `paintAgents` + its `PaintAgentsMsg` type with optional `sets?`/`geom?`/`torus?` (attrs + radius/velocity/position). |
| `src/simulator/SimulatorView.tsx` | Rename modes + label map; agent shape state/refs + size UI; `agentFootprintCells`/`agentsInFootprint`; per-mode single/area routing incl. rigid group move; Edit config panel + prefill/Apply; Ctrl-drag resize brushTarget branch (fix); shape-silhouette cursor; persistence; both pointer handlers (2D + 3D). |
| `src/simulator/ManualBrushPanel.tsx` | Reused as-is (synthetic geometry rows passed in `cellAttributes`); optional small `sectionSplitAfter` prop only if the geometry group needs a visual divider. |
| `src/simulator/render/gl3d.ts` | Reuse existing `setHoverCells`/`pickAgent` — likely no change (confirm the agent footprint highlight path). |
| Docs | `CLAUDE.md` (agent-brush section), `src/help/HelpView.tsx`, `README.md`. No node changes → `NODES_REFERENCE.md` untouched. |

---

## 11. Implementation phases (each ends with a verify)

1. **P1 — Rename** modes `seed→add`, `kill→remove` + label map + tooltips. No behavior change. Verify: agent brush still seeds/kills; button copy reads Add/Remove.
2. **P2 — Shapes (2D)**: agent shape state + size UI + `agentFootprintCells` + shape silhouette cursor + **Ctrl-drag resize brushTarget fix**. Add/Remove use the footprint. Verify: rect/ring/line seed & erase; Ctrl-drag resizes the *agent* shape (grid brush untouched).
3. **P3 — Single/Area (2D)**: the toggle + per-mode routing incl. rigid group move. Verify: single add-one/remove-one/move-one; area group-move carries a cluster.
4. **P4 — Edit (2D)**: `decodeAttrValue`, worker `paintAgents` geom extension, Edit config panel (attrs + geometry rows), pick→prefill→Apply (single) and live area stamp. Verify: edit a picked agent's attrs+radius+velocity; area-edit a region.
5. **P5 — 3D parity**: mirror shapes/scope/edit in the 3D handler (mapStampToPlane footprint, volumetric Add, 3D cursor, group-move on plane). Verify in the voxel view.
6. **P6 — Persistence + docs + regression**: add fields to `genesisca_sim_settings` + `genesisca_agent_edit_v1`; doc sweep; final verify — the 8 agent samples still simulate unchanged, lattice paths untouched, `tsc -b` + build clean.

---

## 12. Verification

- **In-app (preview tools):** Boids (2D) + a 3D agent model — for each mode×scope: seed a rect/ring/line footprint; Ctrl-drag resize the agent shape and confirm the *grid* brush is untouched; rigid-group-drag a cluster; edit a single agent (attrs + radius + velocity + position) via pick→prefill→Apply; area-edit a region. Confirm the seeded/edited state via `getAgentState` round-trips.
- **Regression:** all 8 agent samples simulate as before (agent brush is a UI layer — no engine-step change); lattice (2D+3D, all 3 targets) byte-identical (no compiler touch). `npx tsc -p tsconfig.app.json --noEmit` + `npm run build` clean.

---

## 13. Risks / gotchas (carried from the gap analysis)

1. **Ctrl-drag hits the wrong brush** in agent mode today — the resize branch **must** key on `brushTarget` (both onDown snapshot + onMove math, 2D and 3D). §7.
2. **rAF token collisions** — Add/Move/Edit-area drags each need their **own** rAF token (CLAUDE.md: a shared token clobbers via `cancelAnimationFrame`). Generalize `pendingMoveRef` to hold a moves array for group move; give Edit-area its own batcher.
3. **3D pick permutation** — 3D area/edit/move picking must go pick → `agentInstOrder` → `instanceToSlot`, or it hits the wrong agent when Alpha-blend is on.
4. **Persistence signature key** — the Edit panel merge effect must key off `agentAttrSig` (agent id-space), never `cellAttrSig`, or entries silently vanish on reload / cell-attr edits.
5. **`applyAgentSets` can't set geometry** — the `paintAgents` extension writes `radius/targetRadius`, velocity, and position (with `xNext`) directly on the store; not via `applyAgentSets`.
6. **decode round-trip** — `decodeAttrValue` must emit `'true'`/`'false'` for bool (what `InlineBoolSelect` expects), `String(index)` for tag, packed-int string for neighborIndex (picker needs `is3d` + hint neighborhood).
7. **Torus fold** — footprint membership must fold agent positions across the torus seam (like `killAgentsInRadius`/`agentSeedPoints`), or seam-crossing shapes miss agents.
8. **Both handlers** — every new mode/shape wired in the 2D **and** 3D pointer handlers; the 3D hover-redraw hook (`updateAgentHover`) needs the new footprint cursor.
9. **Clear-All visibility** — the taller panel (mode + shape + size + scope + edit config) must not push the Clear-All button out of the `maxHeight:380; overflowY:auto` body.
10. **Position overwrite in Area scope** stacks agents at one point (expected for "overwrite position"); position is realistically a Single-scope action — leave `__geom_x/y/z__` disabled by default.

# Handoff — "Organize" (auto-layout) on the graph context menu

> The build narrative. The **plan** is [PLAN_AUTO_ORGANIZE.md](PLAN_AUTO_ORGANIZE.md) (+ its
> illustrated companion `.html`), marked DELIVERED with its as-built deviations; the **reference doc**
> is [`areas/modeler-ui.md`](areas/modeler-ui.md) § *Auto-layout (Organize)*, which carries the
> invariants and the traps. This file carries the story, the numbers and the verification transcript.
>
> Branch `debug-mode`. **P1 + P2** shipped as `4e90bd7`; **P3** (groups + comments) and **P4**
> (documentation + Help) are the commit this file ships with.

---

## 1 · What was asked, and what it cost

The user's request, verbatim, was for a context-menu **"Organize"** in the spirit of Unreal's *Blueprint
Assist*: stop making manual node arrangement a mandatory task. Four phases were planned; four were built.

| phase | deliverable | shipped as |
|---|---|---|
| **P1** | the pure module + the harness (`node` / `reroute` kinds only) | `4e90bd7` |
| **P2** | the context-menu wiring, undo, anchoring, the `O` shortcut, the persisted style | `4e90bd7` |
| **P3** | **groups + comments** — G1 super-node contraction, the shared containment helper, comment translate-and-wrap, the box write-back, harness A14 / A15 + controls 8 / 9 | this commit |
| **P4** | documentation + Help | this commit |

**Zero compiler impact, and it is a gate rather than an expectation.** Node positions are not an
emitted surface; `check-compile-identity --compare` reports **31 models, all surfaces unchanged**, and
`verify-handle-remeasure.mjs` is green (the geometry constants it pins now have two consumers).

---

## 2 · P3 — the three hard parts

### 2.1 Group membership is geometric, and it is decided TWICE

The single largest risk in the plan's map (**R2**) was that Organize would re-fit a group's rect around
one set while a later group *drag* carried a different one. Membership has no `parentId` behind it: it is
"the node's centre is strictly inside the rect", computed in `onNodeDragStart` at drag time.

The fix is structural, not careful: **`rectContainsCentre(rect, box)` is exported from `autoLayout.ts`**
and `onNodeDragStart` now calls it through a small `layoutRectOf(node)` bridge over the existing
`nodeSize`. The harness pins the wiring by anchored source grep (section B), including that the old
inline `c.x > rect.x1 …` test is gone. A live drag of an 11-member group straight after an Organize
carried all 11 by the same delta, and no outsider moved.

### 2.2 The super-node contraction, and the two fixed points it needed

A group is contracted to one box: its members are laid out by a recursive call, the box is sized to that
result plus the padding and the header strip, its members' external edges are carried on synthetic
`"<handle>@<member id>"` handles (which `parseHandleId` still reads the category off), the outer layout
places it, and the inner result is translated into it. Nesting recurses. A group with edges in both
directions to the outside creates a super-node-level cycle the flat graph never had — `fxGroupCycle` is
exactly that shape, and the back-edge marking pays for it.

Two idempotence failures showed up only against the real library, and both were **fixed points that were
not**:

- **The super-node's seed position.** Seeding it at the group's own top-left pairs the FITTED size with
  the user's arbitrary rect, so the first Organize and the second see different x intervals — and Tidy
  clusters its columns from exactly those. Elementary CA 1D moved **43 nodes** on the second run. Seeding
  from the members' bbox minus the padding is a fixed point by construction (after a run the members
  start at exactly `groupPos + pad`, so it returns the group's own position).
- **The barycentre ordering.** A fixed four sweeps stopped at **21 crossings** when seeded by the user's
  arrangement and reached **17** when seeded by its own output. The sweeps now stop after two consecutive
  quiet sweeps (never one — they alternate direction) and the whole loop is re-seeded with its accepted
  answer until no round improves. `bestW` decreases strictly across rounds, so it terminates; the bound is
  belt and braces. **It is not slower** (§ 5).

### 2.3 Comments: "translate if empty" is not a fixed point either

§4.11 said an empty comment simply follows the anchor delta. That is not idempotent: the layout can slide
a node under a free-floating comment, and the *next* Organize then wraps it and moves the comment —
observed on snake, MNCA, Extended Wireworld and gas_particles. The shipped rule seeds the wrap from a
**union** (what the comment used to contain, plus what sits under the translated *and snapped* rect) and
then iterates the wrap to a fixed point. Testing the pre-snap rect was itself a bug: grid rounding slid
the comment up to 10 px onto a node the seed had not seen.

### 2.4 The write-back mirrors a manual resize exactly

`toGraphNodes` serialises `measured.width ?? width ?? style.width`, and React Flow's own NodeResizer
change writes `measured` **and** the top-level `width`/`height`, with `onResizeEnd` writing
`data.width/height`. A `style`-only write would therefore be swallowed by the stale `measured` and the
new rect would be lost on save. Organize writes **all four**. Verified in the real UI: after an Organize,
Kelp War's groups report `width/height/measured/style/data` all equal and `measured ?? width ?? style` =
the new size; and a real NodeResizer drag on top of that still works (440×780 → 520×880).

---

## 3 · Measurements

### 3.1 Quality, per model (plan §7.2's six)

Overlaps / leftward edges / bbox area are computed at the **saved-file fallback sizes** (200×100 per
caNode — the basis the harness uses, since a `.gcaproj` carries no `measured`), so the "before" overlap
count is higher than what the browser shows with measured heights. `x` is `stats.crossings`.

| model / scope | nodes | before | Tidy | Compact | Expanded |
|---|---|---|---|---|---|
| Game of Life / cells | 12 | ov 3 · left 5 · 727 k | ov 0 · x 0 · left 0 · 588 k | ov 0 · x 1 · left 0 · 568 k | ov 0 · x 1 · left 0 · 812 k |
| Amphiphile / cells | 84 | ov 28 · left 21 · 7 903 k | ov 0 · x 1 · left 0 · 14 950 k | ov 0 · x 0 · left 0 · 16 354 k | ov 0 · x 0 · left 0 · 25 378 k |
| Kelp War / cells | 27 | ov 10 · left 9 · 1 349 k | ov 0 · x 0 · left 0 · 2 274 k | ov 0 · x 0 · left 0 · 2 122 k | ov 0 · x 0 · left 0 · 3 216 k |
| Accretor / cells (3D) | 71 | ov 24 · left 31 · 8 838 k | ov 0 · x 4 · left 0 · 5 760 k | ov 0 · x 7 · left 0 · 4 879 k | ov 0 · x 7 · left 0 · 7 783 k |
| Particle Life / agents | 37 | ov 0 · left 1 · 3 963 k | ov 0 · x 2 · left 0 · 3 488 k | ov 0 · x 4 · left 0 · 3 806 k | ov 0 · x 4 · left 0 · 5 683 k |
| Life3D / cells | 20 | ov 0 · left 0 · 2 433 k | ov 0 · x 0 · left 0 · 1 279 k | ov 0 · x 1 · left 0 · 1 530 k | ov 0 · x 1 · left 0 · 2 232 k |

**Every style, every model: zero overlaps and zero leftward edges.** Area grows on the two models whose
hand-placement was tight (Amphiphile, Kelp War) and *shrinks* on the two biggest sprawls (Accretor
−45 %, Life3D −47 %) — the layout trades width for a readable spine, and Tidy is the style that
preserves a deliberate arrangement.

### 3.2 Timing

`verify-auto-layout.mjs` section C: **31 models, 53 scopes, 1 495 laid-out nodes; slowest 7–10 ms** on
the 76–84-node scopes (Amphiphile / Chromatography / Elementary CA 1D / Accretor), all three styles.
Per-gesture in the real UI the whole Organize (build the input, lay out, `setNodes`) is imperceptible.

### 3.3 A12 — the budget decision

| fixture | plan's soft target | measured (median of 15, warm) | new soft target |
|---|---|---|---|
| 300 nodes | 5 ms | **3 – 8 ms** (run-to-run spread 5.5 – 14.3) | **12 ms** |
| 1000 nodes | 16 ms | **19 – 31 ms** (spread 16.4 – 34.5) | **40 ms** |

**Decision: raise the soft targets, do not chase the win.** Profiling first, as required. The generated
1000-node fixture is a **751-column** chain — far longer than any rule graph, and nothing like the
shipped library's shape — and the cost is spread across the per-column straightening, separation and
crossing counting rather than sitting in one hot spot. The direct test: halving the two sweep settings
(`MAX_SWEEPS` 12 → 4, `ORDER_ROUNDS` 4 → 1) measured **23.6 ms vs 19.0 ms** at 1000 nodes, i.e. *no*
improvement inside the noise — and those settings are what idempotence needs, so they are not available
to trade anyway. 12 / 40 ms is still well under one frame for anything realistic (the largest shipped
scope is 91 nodes at ~10 ms), and the **hard fail stays at 4×** (48 / 160 ms), which is what would catch
a real complexity regression. The *models are WIP* rule is respected: the budget is still sized to 1000
nodes, not to today's library.

---

## 4 · The harness

`node scripts/verify-auto-layout.mjs` → **AUTO-LAYOUT ✓ — 1 854 checks passed** (1 254 before P3).

- **Section A** — A1–A17 on **15** synthetic fixtures × 3 styles. New in P3: `fxGroup` (a deliberately
  narrow, tall group whose Compact layout is far wider than the old rect, so dropping the re-fit spills
  the members straight out), `fxNestedGroup` (a group inside a group, the outer one's centre deliberately
  below the inner rect), `fxGroupCycle` (in-and-out edges ⇒ a super-node cycle) and `fxComment` (one
  comment whose subject the layout lifts 800 px, one that annotates nothing).
  **A14** asserts, for every group, `pre ⊆ post` *and* that no outsider was captured; **A15** asserts
  `pre ⊆ post` for every comment. Both are stated with the SHIPPED `rectContainsCentre`, and both run on
  every fixture **and** on every shipped scope in section C. A7 now replays the **rects** as well as the
  positions (the editor persists both, so an idempotence claim that replayed only positions would be
  testing a state the app never reaches).
- **Section B** — the port-geometry mirror, plus the new **containment mirror**: `autoLayout` exports
  `rectContainsCentre`, it is strict on all four sides, `GraphEditor` imports it, `onNodeDragStart` calls
  it, its old inline copy is gone, and `layoutRectOf` is the one bridge.
- **Section C** — 31 models, 53 scopes, 1 495 nodes, three styles, asserting A1/A2/A3/A6/A7/A14/A15.

### Negative controls (`--controls`) — **9/9 discriminate**

| # | mutation | what fails |
|---|---|---|
| 1 | drop the column separation (both the priority clamp's lower bound and the defensive sweep) | A1 — 308 failures |
| 2 | make the value pass push RIGHT instead of left | A3b — 2 |
| 3 | make the barycentre sort unstable (random tie-break) | A6 / A7 — 79 |
| 4 | drop the ×4 FLOW weight | **A4c** — 3 |
| 5 | round each coordinate in isolation instead of relative to the rounded anchor | A9 — 12 |
| 6 | drop the back-edge marking | A10 — 8 |
| 7 | drop the topological repair sweep | A3 on `crossChainValue` — 84 |
| 8 | **drop the group RE-FIT** (members still laid out inside, the rect keeps its old size) | **A14** — 136 |
| 9 | **drop the comment RE-WRAP** (every comment just follows the anchor delta, as P1/P2 did) | **A15** — 5 |

⚠ **Control 4 had to be re-aimed in P3.** Once the ordering sweeps to a fixed point, the synthetic
`fxFlowWeight` fixture reaches the straight chain with or without the ×4 weight, so A4b stopped
discriminating. The weight is still load-bearing — it changes the answer on **20 of 159** library
scopes — so the claim moved to measured VALUES on the real library (**A4c**): Amphiphile's root scope,
the largest shipped one, comes out at **0 crossings** with the weight and **1** without, Expanded the
same, and Boids – Hemifield Vision's agent graph goes **4 → 5**.

---

## 5 · Real-UI verification

Dev server, real right-clicks on the pane, real hover into the `Organize ›` submenu, real leaf clicks,
real `Ctrl+Z`, real drags. **0 console errors throughout** (an `window.onerror` + `console.error` hook
installed before the first load and read after every step).

| model | what was checked | result |
|---|---|---|
| **Kelp War** (27 caNodes, 2 groups, 1 comment) | all three styles from the pane menu | group A **6 → 6** members, group B **11 → 11**, `lost = 0` and `gained = 0` for every style; **0 node overlaps** after each (measured over the rendered boxes); the comment's text and rect untouched (it contained nothing before and after) |
| | the group rects | Compact `676×241 → 840×340` and `430×818 → 460×900`; Expanded `→ 1020×340` / `520×1160`; Tidy `→ 740×340` / `440×780` |
| | the serialised size | all four slots agree — `width`/`height` = `measured` = `style` = `data.width/height`, and `measured ?? width ?? style` (what `toGraphNodes` writes) = the new size |
| | **one `Ctrl+Z`** | **30/30 nodes restored exactly** — every position *and* every group/comment rect, node for node |
| | **manual resize after an Organize** | a real NodeResizer drag on the bottom-right handle: `440×780 → 520×880`, with `width`/`height`/`measured`/`data` all updated — the Organize write-back does not block a later manual resize |
| | **group drag after an Organize** | a real drag on the group header moved it by (60, 60) and **all 11 members followed by exactly the same delta**; **no** node outside the group moved |
| **Amphiphile** (84 caNodes, **7 groups**) | all three styles | every one of the 7 groups keeps exactly its members (`lost = 0`, `gained = 0`) on Tidy, Compact and Expanded; **3 rendered overlaps → 0**; one `Ctrl+Z` restored all 91 nodes exactly |
| **Accretor** (71 caNodes, **5 reroutes**, 3 comments, **3D**) | Compact on the cells graph | 0 overlaps, 79 nodes intact, the three comments kept their size and only snapped to the grid (each contained nothing before and after), the five reroutes landed off-grid on their wires |
| | the **Overseer** graph (Overseer extension enabled, `Cells / Overseer` sub-tabs) | 8 nodes, 7 moved, 0 overlaps |
| **Help tab** | the new Organize paragraph in the Modeler chapter and the `O` row in the shortcuts table | render (see § 7) |

The group-header geometry was measured in the live DOM rather than read off the CSS: the header's bottom
edge sits **27 px** below the node top and its margin adds 4 more, i.e. content starts at **31 px** —
`GROUP_HEADER_H = 32` clears it by one pixel.

---

## 6 · Gates

```
node scripts/verify-auto-layout.mjs                  AUTO-LAYOUT ✓ — 1854 checks passed
node scripts/verify-auto-layout.mjs --controls       NEGATIVE CONTROLS ✓ — 9/9 discriminate
node scripts/verify-handle-remeasure.mjs             HANDLE-REMEASURE INVARIANTS ✓
node scripts/check-compile-identity.mjs --compare …  BYTE-IDENTITY OK — 31 models, all surfaces unchanged
npx tsc -p tsconfig.app.json --noEmit                clean
npx tsc -b                                           clean
npm run build                                        clean
node scripts/check-claude-md-budget.mjs              310/600 lines (52 %) · 28.1/60 KB (47 %) · OK
```

---

## 7 · Documentation layers updated (P4)

| layer | what changed |
|---|---|
| `src/modeler/vpl/autoLayout.ts` | the module's own doc comments carry every invariant at the code that enforces it |
| [`docs/areas/modeler-ui.md`](areas/modeler-ui.md) | new **Auto-layout (Organize)** reference section (entry points + the doctrine call · the three styles and why `ParameterStyle` / knot insertion are not styles · decision **G1** and the shared `rectContainsCentre` · the selected-group rule · comments · reroutes · anchor + no-`fitView` · the grid-vs-`gapY` invariant · the `portY` mirror · the measurement gate · the one-snapshot discipline and the persistence quadruple · the Organize-Selection limitation · the macro-def note · the absolute-position invariant) + a Contents row; the stale **`resizeGroupsToFit`** bullet rewritten to say what the source actually does now; the CaNode body-port bullet now points at `nodeGeometry.ts` as the one definition |
| [`docs/areas/macros.md`](areas/macros.md) | a new ⚠ note beside *UNDO IS SCOPE-LOCAL*: a def's positions are shared, so Organize inside a def re-lays it once for every instance |
| [`docs/areas/project-structure.md`](areas/project-structure.md) | `autoLayout.ts` and `nodeGeometry.ts` beside `alignmentSnap.ts`; `verify-auto-layout.mjs` in the scripts list |
| [`docs/areas/testing-harnesses.md`](areas/testing-harnesses.md) | the `verify-auto-layout.mjs` row in the *Verifiers* table (sections, A14/A15, `--controls` 9) and the count **68 → 69** |
| `CLAUDE.md` | the harness count **68 → 69** in § *Verification gates* — the only edit; no new section, no new routing row |
| `src/help/HelpView.tsx` | an Organize paragraph in the Modeler chapter's canvas-controls list (the three styles, Organize Selection, the single undo, the two things worth knowing) + an `O` row in the shortcuts table |
| `src/components/KeyboardShortcutsOverlay.tsx` | the `O` row (P2) |
| `README.md` | **checked, unchanged** — the `## Features` section is deliberately product-level, and an editor convenience does not alter any of its one-to-three-sentence summaries |
| [`docs/PLAN_AUTO_ORGANIZE.md`](PLAN_AUTO_ORGANIZE.md) | marked **DELIVERED** with a 16-row *As built — deviations* table (ten from P1+P2, six from P3+P4, plus three smaller ones) |

---

## 8 · Follow-ups register

Nothing below is a defect; each is a deliberate v1 boundary.

| # | follow-up | why it was left |
|---|---|---|
| F1 | **Single-node `Organize ›`** ("organize the subtree rooted here" / "this connected component") | most library graphs are one root's tree, so the pane entry already covers them. Revisit when a model exists where it does not. |
| F2 | **Knot / reroute insertion** on long and backward wires (`bCreateKnotNodes`, `ExecutionWiringStyle=AlwaysMerge`) | it MUTATES the graph — edge ids, the `.gcaproj` diff, `collapseReroutes`, and a much larger undo story. v1 preserves existing reroutes and creates none. |
| F3 | **`bCenterBranches` / `NumRequiredBranches`** — centre a node between its branch targets | a straightening refinement. Measure whether the current rule already reads well first; the library's crossing counts (§3.1) suggest it does. |
| F4 | **Align / Distribute onto the shared size resolver (R16)** | both still use hardcoded `NODE_W = 200` / `NODE_H = 100` and are therefore wrong for every real node. Pre-existing, out of this feature's scope, but the new module is not the one that is wrong. |
| F5 | **Pushing unselected neighbours out of the way** on Organize Selection | Align and Distribute have the same behaviour; matching them is the consistent answer, and the Help chapter says so. A "push outsiders" pass is a separate design question (what does undo restore?). |
| F6 | **`FormatAllHorizontalAlignment` across components** beyond the vertical stack | no model in the library has enough disconnected components for it to matter yet. |
| F7 | A comment that ends up **inside a group** can have its re-wrapped rect spill outside the group's | comments are not group members for layout purposes; the group's inner bbox does not account for them. No shipped model hits it. |

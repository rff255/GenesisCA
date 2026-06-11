# Unified searchable Add-Node menu (Spacebar + right-click)

Status: **implemented** (modeler_ux_batch). Mockup: [PLAN_SPACEBAR_QUICKADD_MENU.html](PLAN_SPACEBAR_QUICKADD_MENU.html).

## Context
The connection-drop menu (drag a wire off a port, release on empty canvas) is the app's best add-node UX — a focused, searchable, keyboard-navigable node list. The two other add-node entry points were weaker:
- **Spacebar** opened the whole right-side **Palette** panel (heavy, off to the side, away from the cursor).
- **Right-click on blank canvas** had an **Add Node ›** hover-submenu you had to scroll (no search).

Goal: make **both** Spacebar and right-click open one consistent menu at the cursor — the existing pane actions (Paste / Add Comment / Add Group / Import Macro…) on top, then a focused search field, then the category-grouped, keyboard-navigable node list (same UX as the connection-drop menu). Enter adds the highlighted node at the menu's flow position; Esc closes. Purely an editor-UX change — no compiler/schema/runtime impact.

## What changed
Reused the connection-drop machinery by generalizing it to a second context-menu target, `{ type: 'pane' }`.

- **`GraphEditor.tsx`**
  - `dropMenuItems` memo now serves both `connection-drop` and `pane`. Pane = every node `isNodeAvailable` to the model (minus `HIDDEN_FROM_DROP_MENU` + placed Step/Init singletons), no Reroute, no port-compatibility filter. Connection-drop unchanged (Reroute + compatible-port filter).
  - Extracted the search input + keyboard handler + flat category-headered rows into one `renderQuickAddSearch(placeholder, emptyText)` helper, used by both the `pane` and `connection-drop` render branches. The rows live in a `.dropList` scroll region so the pinned options + search stay visible.
  - `commitDropMenuItem`: pane item → `addNodeAtPosition` (no wiring); connection-drop → `addNodeAndConnect` / `addRerouteAndConnect`.
  - Focus + scroll-into-view effects broadened to fire for `pane` too.
  - Pane menu JSX: kept the action options, **removed** the `Add Node ›` hover-submenu (and the now-dead `categories` / `addNode` helpers + `getNodeDefsByCategory` import).
  - Added `lastClientMousePos` (set in the pane `onMouseMove`) and an `openQuickAddMenu()` method on the registered `quickAddApi` that opens the `pane` menu at the cursor.
- **`graphState.ts`** — `QuickAddApi` gains `openQuickAddMenu()`.
- **`ModelerView.tsx`** — the Space handler calls `quickAddApi.openQuickAddMenu()` instead of opening the Palette; removed the now-dead `quickAddPosRef`. The Palette keeps its own manual quick-add.
- **`GraphEditor.module.css`** — added `.dropList { max-height; overflow-y }`.

## Verification (done)
`npx tsc -b` clean. In-browser (`preview_eval`):
- Spacebar → menu opens at the cursor, search focused, **Palette does not open**; options on top (Paste conditional), old submenu gone, all 7 categories, Step omitted (singleton). Type `neighbor` → list filters, selection anchors to the first prefix match; Enter adds exactly that node (+1) and closes; ↑/↓ move the highlight; Esc closes with no node added.
- Connection-drop menu (`window.__openConnectionDropMenu`) still works unchanged (Reroute first, "integer output → compatible node" title, compatible nodes).
- Right-click pane menu uses the identical `pane` render path (covered by the Spacebar test; `onPaneContextMenu` unchanged).

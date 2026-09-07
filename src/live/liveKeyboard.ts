/** KEYBOARD OWNERSHIP — the predicates every global key handler shares.
 *
 *  Born with LIVE mode (Phase 4), but deliberately NOT Live-only: the two
 *  defects it exists to fix are pre-existing and reachable from the plain
 *  Modeler / Simulator tabs.
 *
 *  ⚠ Fifteen global keyboard listeners are live at once in this app, and
 *  `SimulatorView` is ALWAYS MOUNTED (it sits behind `display: none` on every
 *  other tab), so its listeners fire in the Modeler too. Before Phase 4 that
 *  meant `Esc` in the Modeler RESET the running simulation and `Enter` advanced
 *  it by a batch. The rule now is: a handler acts only when its surface is (a)
 *  on screen, (b) the focused surface in Live, and (c) not standing behind a
 *  modal or a menu that owns the keyboard itself.
 *
 *  See `docs/areas/simulator-ui.md` § *LIVE mode — INPUT OWNERSHIP* for the
 *  full per-key table.
 */

/** The user is typing: a text field or a rich-text surface has focus.
 *
 *  ⚠ `SELECT` is deliberately NOT here. It is in the caller's own check where a
 *  key has a native meaning in a dropdown — but a `<select>` KEEPS FOCUS after
 *  the user picks an option, and picking an option in a node is the commonest
 *  way to make an edit, so a blanket SELECT stand-down makes the very shortcuts
 *  the user reaches for next do nothing. (The same reasoning Phase 3 recorded
 *  for `Ctrl+Enter`.) Callers that must respect a dropdown add `SELECT`
 *  themselves; callers of a key with no native `<select>` meaning do not.
 */
export function isTypingTarget(el: Element | null = document.activeElement): boolean {
  const e = el as HTMLElement | null;
  const tag = e?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (e?.isContentEditable ?? false);
}

/** A modal dialog or an open menu owns the keyboard right now.
 *
 *  Detected from the DOM rather than from a registry, because the surfaces that
 *  need it are written by six different components and every one of them
 *  already renders **only while open** (`if (!open) return null` / `{cond &&
 *  …}`), so their mere presence in the document IS the signal. `role="dialog"`
 *  / `role="menu"` are the correct ARIA for these surfaces anyway.
 *
 *  ⚠ Why not "is the focus inside one": the quick-add menu focuses its search
 *  input on a 50 ms timer (its first frame renders `visibility: hidden` for
 *  viewport clamping, and focusing a hidden element silently no-ops), so for
 *  50 ms after it opens `document.activeElement` is still the `<body>` — and
 *  that is exactly the window in which a user who opened it with `Space` presses
 *  `Enter`.
 *
 *  ⚠ A new modal must carry `role="dialog"` or its `Enter` will ALSO reach the
 *  simulator transport (before Phase 4, `Enter` on a `ConfirmDialog` confirmed
 *  the dialog AND toggled play — the dialog's own `window` listener runs after
 *  the simulator's `document` one).
 */
export function overlayOwnsKeyboard(): boolean {
  return document.querySelector('[role="dialog"], [role="menu"]') != null;
}

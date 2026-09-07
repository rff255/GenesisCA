import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { simLayoutApi } from '../simulator/simLayoutState';
import { getLiveLayout, setLiveLayout, subscribeLiveLayout, type LiveApplyPolicy } from './liveUiState';
import { LIVE_LAYOUT_LOCK_REASON, type LiveRuleStatus } from './liveState';
import styles from './LiveViewportBar.module.css';

interface Props {
  /** A capture recording is in progress: every LAYOUT control greys out with
   *  the reason, because the output frame size is pinned on the first frame. */
  locked: boolean;
  /** What the worker is running relative to what the model says (Phase 3). */
  ruleStatus: LiveRuleStatus;
  /** The compile error / the reason, shown in the chip's tooltip. */
  ruleMessage: string;
  /** Apply whatever is being held back (also bound to Ctrl+Enter). */
  onApply: () => void;
  /** What a rebuild would put on the board, resolved by the simulator's own
   *  `resetDefaultMode` — the prompt has to name it, because "re-seed" and
   *  "restore the saved board" are very different outcomes. */
  rebuildOutcome: string;
}

/** The chip's four states. `ok` reads as a quiet confirmation; the other three
 *  are the ones that need a colour and, where something can be done about them,
 *  a button. */
const CHIP: Record<LiveRuleStatus, { dot: string; label: string; cls: string; hint: string }> = {
  ok: { dot: '●', label: 'Synced', cls: 'chipOk', hint: 'The running rule is this graph.' },
  stale: {
    dot: '●', label: 'Stale', cls: 'chipStale',
    hint: 'The graph does not compile, so the simulation is still running the LAST GOOD rule. '
      + 'Fix the nodes marked with ! and it takes over — the run is not interrupted.',
  },
  pending: {
    dot: '●', label: 'Pending', cls: 'chipPending',
    hint: 'Apply policy is "On demand": edits are held until you apply them (Ctrl+Enter).',
  },
  rebuild: {
    dot: '⟳', label: 'Rebuild needed', cls: 'chipRebuild',
    hint: 'A structural change (grid size, attributes, neighbourhoods, capabilities…) needs the '
      + 'world rebuilt, which re-seeds the board. Nothing has been applied yet.',
  },
};

const icon = (children: React.ReactNode) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const LAYOUT_ICON = icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></>);
/** Apply policy: a lightning bolt for Auto, a hand-off arrow for On demand. */
const AUTO_ICON = icon(<path d="M13 2 4 14h6l-1 8 9-12h-6z" />);
const ONDEMAND_ICON = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></>);

/** The apply-policy options, in the order the popover lists them. The LABEL is
 *  what the collapsed button shows, so it also has to read on its own — the
 *  vocabulary is the same one HelpView and the chip tooltips use. */
const POLICY: Record<LiveApplyPolicy, { label: string; glyph: React.ReactNode; blurb: string }> = {
  auto: {
    label: 'Auto', glyph: AUTO_ICON,
    blurb: 'Every graph edit reaches the running simulation as you make it.',
  },
  ondemand: {
    label: 'On demand', glyph: ONDEMAND_ICON,
    blurb: 'Edits are held until you press Apply (or Ctrl+Enter).',
  },
};
const POLICY_ORDER: LiveApplyPolicy[] = ['auto', 'ondemand'];
const POLICY_TITLE =
  'Apply policy — how a graph edit reaches the running simulation.\n\n'
  + 'Auto: every edit is sent as soon as it compiles.\n'
  + 'On demand: edits are held (the chip says Pending) until Apply / Ctrl+Enter.';

/**
 * LIVE MODE — the compact bar over the simulation viewport pane.
 *
 * It is rendered by `SimulatorView` INSIDE `.canvasArea` (never by `App`): the
 * bar has to sit over the canvas, and every canvas overlay in this app MUST
 * carry `data-sim-overlay` or a click on it falls through and paints the grid.
 *
 * It carries the TRANSPORT CHIP (synced / stale / pending / rebuild needed) with
 * its Apply / Later prompt, the APPLY-POLICY control (Auto / On demand) and the
 * layout menu (dock right · dock bottom · swap sides · collapse viewport). Both
 * pipeline controls exist ONLY in Live — the Simulator tab's surface for a
 * compile error is the red banner, and a chip there would be meaningless rather
 * than merely unavailable, so it is not rendered at all (hide, not grey).
 *
 * ⚠ It carries NO panel toggles. Phase 2 gave it Settings / Controls buttons
 * because the Live panel policy enters with both simulator side panels
 * collapsed — but the panels' own ears (`panelExpandBtn` /
 * `panelExpandBtnRight`) are still rendered in Live, so those buttons were a
 * SECOND affordance for the same state, which is what the user reported. The
 * ears won (they sit ON the panel edge they act on, and they are the affordance
 * the Simulator tab already teaches); the bar buttons are gone. What that
 * requires of the ears is documented in `SimulatorView.module.css` —
 * `--live-left-inset` / `--live-right-inset` keep them, and this bar, clear of
 * the floating overlay panels.
 */
export function LiveViewportBar({
  locked, ruleStatus, ruleMessage, onApply, rebuildOutcome,
}: Props) {
  const layout = useSyncExternalStore(subscribeLiveLayout, getLiveLayout);
  // ONE popover open at a time (`layout` | `policy`), the SimulatorView
  // `overlayPopup` convention — a single state means they can never both be up,
  // and the dismissal effect below needs only one wrapper ref.
  const [openMenu, setOpenMenu] = useState<'layout' | 'policy' | null>(null);
  const menuOpen = openMenu !== null;
  const menuWrapRef = useRef<HTMLDivElement>(null);
  // "Later" collapses the rebuild prompt to the bare chip WITHOUT applying
  // anything — the deferral itself lives in `SimulatorView`'s `appliedModelRef`,
  // so dismissing the prompt can never lose the change. Clicking the chip brings
  // the buttons back, and any status change resets it (a new situation deserves
  // its own prompt).
  const [promptDismissed, setPromptDismissed] = useState(false);
  useEffect(() => { setPromptDismissed(false); }, [ruleStatus]);

  // Single-popover dismissal, the SimulatorView overlay convention: a
  // capture-phase outside `pointerdown` plus Escape with `stopPropagation` (so
  // the key does not also reach the simulator's own Esc handling).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const w = menuWrapRef.current;
      if (w && e.target instanceof Node && w.contains(e.target)) return;
      setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpenMenu(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  /** Every layout action is a DISCRETE size change, so it must clear the
   *  re-attach deferral and redraw immediately rather than wait out the settle
   *  window. `App`'s layout effect does this too; calling it here as well is
   *  harmless (the redraw is rAF-free and idempotent) and covers the case where
   *  the committed value happened not to change. */
  const applyLayout = useCallback((patch: Parameters<typeof setLiveLayout>[0]) => {
    setLiveLayout(patch);
    setOpenMenu(null);
    requestAnimationFrame(() => simLayoutApi?.drawNow());
  }, []);

  const lockTitle = locked ? LIVE_LAYOUT_LOCK_REASON : undefined;
  const chip = CHIP[ruleStatus];
  const policy = POLICY[layout.applyPolicy];
  const canApply = ruleStatus === 'pending' || ruleStatus === 'rebuild';
  const showActions = canApply && !promptDismissed;
  const chipTitle = ruleStatus === 'rebuild'
    ? `${chip.hint}\n\nApplying it rebuilds the world — the board goes back to ${rebuildOutcome}.`
    : (ruleMessage ? `${chip.hint}\n\n${ruleMessage}` : chip.hint);

  return (
    // `data-live-bar` is how `SimulatorView` finds this element to measure it
    // (it owns the top strip's crowding rule but not this component's tree).
    <div className={styles.bar} data-sim-overlay data-live-bar>
      {/* The transport chip: what the WORKER is running relative to what the
          model now says. Clicking it re-opens a prompt dismissed with Later. */}
      <button
        type="button"
        className={`${styles.chip} ${styles[chip.cls]}`}
        title={chipTitle}
        onClick={() => { if (canApply) setPromptDismissed(d => !d); }}
        // In `ok` / `stale` there is nothing to open, so the chip is a plain
        // readout rather than a button that does nothing when pressed.
        aria-live="polite"
        style={canApply ? undefined : { cursor: 'default' }}
      ><span className={styles.chipDot}>{chip.dot}</span>{chip.label}</button>
      {showActions && (
        <>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={onApply}
            title={ruleStatus === 'rebuild'
              ? `Rebuild the world now — the board goes back to ${rebuildOutcome}. (Ctrl+Enter)`
              : 'Apply the pending edits to the running simulation. (Ctrl+Enter)'}
          >Apply</button>
          {/* Later ONLY exists for the rebuild prompt: a pending on-demand queue
              is already "later" by definition, so a second dismissal there would
              be a control with nothing to do. */}
          {ruleStatus === 'rebuild' && (
            <button
              type="button"
              className={styles.btn}
              onClick={() => setPromptDismissed(true)}
              title="Keep editing — the rebuild stays queued and still costs one reset when you apply it."
            >Later</button>
          )}
        </>
      )}
      {/* Apply policy. Auto is today's behaviour (~100 ms after an edit);
          On demand holds the model→worker step until Apply / Ctrl+Enter.
          ONE button showing the CURRENT policy, opening a two-item popover —
          the two-option segment it replaces spelled both labels out at all
          times, which is ~60 px this bar does not have once the pane is dragged
          narrow. The popover is CLICK-only (never hover): it carries
          `role="menu"`, and `overlayOwnsKeyboard()` treats any open menu as the
          keyboard owner, so a hover-open popover would silently stand the
          global Enter (play/pause) down just for passing the pointer over it. */}
      <div className={styles.menuWrap} ref={openMenu === 'policy' ? menuWrapRef : undefined}>
        <button
          type="button"
          className={`${styles.btn} ${openMenu === 'policy' ? styles.btnActive : ''}`}
          onClick={() => setOpenMenu(m => (m === 'policy' ? null : 'policy'))}
          title={POLICY_TITLE}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'policy'}
        >{policy.glyph}{policy.label}</button>
        {openMenu === 'policy' && (
          <div className={styles.menu} role="menu" aria-label="Apply policy" data-sim-overlay>
            <div className={styles.menuLabel}>Apply policy</div>
            {POLICY_ORDER.map(id => (
              <button
                key={id}
                type="button" role="menuitemradio" aria-checked={layout.applyPolicy === id}
                className={`${styles.menuItem} ${layout.applyPolicy === id ? styles.menuItemActive : ''}`}
                onClick={() => { setLiveLayout({ applyPolicy: id }); setOpenMenu(null); }}
                title={POLICY[id].blurb}
              >
                <span className={styles.menuCheck}>{layout.applyPolicy === id ? '✓' : ''}</span>
                <span className={styles.menuItemText}>
                  {POLICY[id].label}
                  <span className={styles.menuItemBlurb}>{POLICY[id].blurb}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={styles.sep} />
      <div className={styles.menuWrap} ref={openMenu === 'layout' ? menuWrapRef : undefined}>
        <button
          type="button"
          className={`${styles.btn} ${openMenu === 'layout' ? styles.btnActive : ''}`}
          onClick={() => setOpenMenu(m => (m === 'layout' ? null : 'layout'))}
          title="Workspace layout"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'layout'}
        >{LAYOUT_ICON}Layout</button>
        {openMenu === 'layout' && (
          <div className={styles.menu} role="menu" data-sim-overlay>
            <div className={styles.menuLabel}>Viewport position</div>
            <button
              type="button" role="menuitemradio" aria-checked={layout.dock === 'right'}
              className={`${styles.menuItem} ${layout.dock === 'right' ? styles.menuItemActive : ''}`}
              disabled={locked} title={lockTitle}
              onClick={() => applyLayout({ dock: 'right' })}
            ><span className={styles.menuCheck}>{layout.dock === 'right' ? '✓' : ''}</span>Dock right</button>
            <button
              type="button" role="menuitemradio" aria-checked={layout.dock === 'bottom'}
              className={`${styles.menuItem} ${layout.dock === 'bottom' ? styles.menuItemActive : ''}`}
              disabled={locked} title={lockTitle}
              onClick={() => applyLayout({ dock: 'bottom' })}
            ><span className={styles.menuCheck}>{layout.dock === 'bottom' ? '✓' : ''}</span>Dock bottom</button>
            <div className={styles.menuSep} />
            <button
              type="button" role="menuitemcheckbox" aria-checked={layout.swapped}
              className={`${styles.menuItem} ${layout.swapped ? styles.menuItemActive : ''}`}
              disabled={locked} title={lockTitle}
              onClick={() => applyLayout({ swapped: !layout.swapped })}
            ><span className={styles.menuCheck}>{layout.swapped ? '✓' : ''}</span>Swap sides</button>
            {/* Collapse only — this bar lives INSIDE the viewport pane, so once
                collapsed it is off screen and could never offer the inverse.
                The restore affordance is the ear `LiveSplitter` renders in the
                splitter's own slot. */}
            <button
              type="button" role="menuitem"
              className={styles.menuItem}
              disabled={locked} title={lockTitle}
              onClick={() => applyLayout({ viewportCollapsed: true })}
            >
              <span className={styles.menuCheck} />
              Collapse viewport
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

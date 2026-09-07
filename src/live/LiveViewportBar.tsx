import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { simLayoutApi } from '../simulator/simLayoutState';
import { getLiveLayout, setLiveLayout, subscribeLiveLayout } from './liveUiState';
import { LIVE_LAYOUT_LOCK_REASON, type LiveRuleStatus } from './liveState';
import styles from './LiveViewportBar.module.css';

interface Props {
  /** The simulator's Settings (left) panel is open. */
  settingsOpen: boolean;
  /** The simulator's Controls (right) panel — brush + layers + indicators. */
  controlsOpen: boolean;
  onToggleSettings: () => void;
  onToggleControls: () => void;
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
const SETTINGS_ICON = icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 14.5a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>);
const CONTROLS_ICON = icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M3 10h12M3 15h12" /></>);
const LAYOUT_ICON = icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></>);

/**
 * LIVE MODE — the compact bar over the simulation viewport pane.
 *
 * It is rendered by `SimulatorView` INSIDE `.canvasArea` (never by `App`): the
 * bar has to sit over the canvas, and every canvas overlay in this app MUST
 * carry `data-sim-overlay` or a click on it falls through and paints the grid.
 *
 * It carries the two panel toggles — the Live policy collapses the simulator's
 * own side panels on entry, so the brush / layers / indicators would otherwise
 * be unreachable without hunting for the collapsed-panel ears — plus the layout
 * menu (dock right · dock bottom · swap sides · collapse viewport).
 *
 * Phase 3 added the two pipeline controls: the APPLY-POLICY switch (Auto /
 * On demand) and the TRANSPORT CHIP (synced / stale / pending / rebuild needed).
 * Both exist ONLY in Live — the Simulator tab's surface for a compile error is
 * the red banner, and a chip there would be meaningless rather than merely
 * unavailable, so it is not rendered at all (hide, not grey).
 */
export function LiveViewportBar({
  settingsOpen, controlsOpen, onToggleSettings, onToggleControls, locked,
  ruleStatus, ruleMessage, onApply, rebuildOutcome,
}: Props) {
  const layout = useSyncExternalStore(subscribeLiveLayout, getLiveLayout);
  const [menuOpen, setMenuOpen] = useState(false);
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
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenuOpen(false);
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
    setMenuOpen(false);
    requestAnimationFrame(() => simLayoutApi?.drawNow());
  }, []);

  const lockTitle = locked ? LIVE_LAYOUT_LOCK_REASON : undefined;
  const chip = CHIP[ruleStatus];
  const canApply = ruleStatus === 'pending' || ruleStatus === 'rebuild';
  const showActions = canApply && !promptDismissed;
  const chipTitle = ruleStatus === 'rebuild'
    ? `${chip.hint}\n\nApplying it rebuilds the world — the board goes back to ${rebuildOutcome}.`
    : (ruleMessage ? `${chip.hint}\n\n${ruleMessage}` : chip.hint);

  return (
    <div className={styles.bar} data-sim-overlay>
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
          On demand holds the model→worker step until Apply / Ctrl+Enter. */}
      <div className={styles.segment} role="group" aria-label="Apply policy">
        <button
          type="button" role="radio" aria-checked={layout.applyPolicy === 'auto'}
          className={`${styles.segBtn} ${layout.applyPolicy === 'auto' ? styles.segBtnActive : ''}`}
          onClick={() => setLiveLayout({ applyPolicy: 'auto' })}
          title="Auto — every graph edit reaches the running simulation as you make it."
        >Auto</button>
        <button
          type="button" role="radio" aria-checked={layout.applyPolicy === 'ondemand'}
          className={`${styles.segBtn} ${layout.applyPolicy === 'ondemand' ? styles.segBtnActive : ''}`}
          onClick={() => setLiveLayout({ applyPolicy: 'ondemand' })}
          title="On demand — edits are held until you press Apply (or Ctrl+Enter)."
        >On demand</button>
      </div>
      <div className={styles.sep} />
      <button
        type="button"
        className={`${styles.btn} ${settingsOpen ? styles.btnActive : ''}`}
        onClick={onToggleSettings}
        title="Simulator settings panel (recompile, dimensions, presets, model attributes)"
      >{SETTINGS_ICON}Settings</button>
      <button
        type="button"
        className={`${styles.btn} ${controlsOpen ? styles.btnActive : ''}`}
        onClick={onToggleControls}
        title="Brush, layers and indicators"
      >{CONTROLS_ICON}Controls</button>
      <div className={styles.menuWrap} ref={menuWrapRef}>
        <button
          type="button"
          className={`${styles.btn} ${menuOpen ? styles.btnActive : ''}`}
          onClick={() => setMenuOpen(o => !o)}
          title="Workspace layout"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >{LAYOUT_ICON}Layout</button>
        {menuOpen && (
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

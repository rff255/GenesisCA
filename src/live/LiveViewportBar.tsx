import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { simLayoutApi } from '../simulator/simLayoutState';
import { getLiveLayout, setLiveLayout, subscribeLiveLayout } from './liveUiState';
import { LIVE_LAYOUT_LOCK_REASON } from './liveState';
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
}

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
 * ⚠ NOT HERE YET, deliberately: the apply-policy switch and the transport chip.
 * Phase 2 does not change the edit→rule pipeline, so both would be visible,
 * enabled and internally inert — exactly what the "an enabled control must do
 * something" rule forbids. Phase 3 lands the behaviour and the controls together.
 */
export function LiveViewportBar({
  settingsOpen, controlsOpen, onToggleSettings, onToggleControls, locked,
}: Props) {
  const layout = useSyncExternalStore(subscribeLiveLayout, getLiveLayout);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className={styles.bar} data-sim-overlay>
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

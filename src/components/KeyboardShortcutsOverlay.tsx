/**
 * KeyboardShortcutsOverlay — a quick-reference modal listing the app's
 * keyboard shortcuts and mouse gestures, grouped by area. Opened from the
 * navbar "?" button or the `?` key; closed with Esc, the × button, or a
 * backdrop click. Theme-aware (all colors via CSS variables).
 *
 * This is the discoverability surface for the many keyboard-only actions —
 * the in-app Help tab has the full prose; this is the at-a-glance cheat sheet.
 */

import { Fragment, useEffect } from 'react';
import styles from './KeyboardShortcutsOverlay.module.css';

type Row = [keys: string, action: string];

/** `wide` — this group's key chips are long, so it spans the whole grid
 *  instead of sharing a column (see the module CSS's layout rule). */
const GROUPS: { title: string; rows: Row[]; wide?: boolean }[] = [
  {
    title: 'Modeler — graph',
    rows: [
      ['Space', 'Add node at cursor'],
      ['Ctrl + F', 'Search nodes'],
      ['F', 'Fullscreen graph (toggle panels)'],
      ['Ctrl + Z', 'Undo'],
      ['Ctrl + Shift + Z', 'Redo'],
      ['Ctrl + C / V / X', 'Copy / paste / cut nodes (also between browser tabs)'],
      ['Ctrl + D', 'Duplicate nodes'],
      ['Ctrl + drag', 'Align while dragging'],
      ['Right-click', 'Context / add-node menu'],
      ['Press-hold on a wire', 'Drop a reroute point'],
    ],
  },
  {
    title: 'Simulator',
    rows: [
      ['Space', 'Step one generation'],
      ['Enter', 'Play / pause'],
      ['Esc', 'Reset'],
      ['F', 'Fullscreen canvas (toggle panels)'],
      ['Ctrl + C / V / X', 'Copy / paste / cut cells or agents (3D: anchored on the brush plane)'],
      ['Ctrl + wheel', 'Cycle input mappings'],
      ['Ctrl + drag', 'Resize brush (Push / Pull: ↔ radius, ↕ intensity)'],
      ['Shift + click', 'Inspect cell'],
      ['Right-click drag', 'Pan the grid'],
    ],
  },
  {
    // Blender's numpad view keys. Read off the PHYSICAL key, so the top-row
    // digits work too (Blender's "Emulate Numpad") and Shift doesn't break them.
    title: 'Simulator — 3D view (Blender numpad)',
    wide: true,
    rows: [
      ['7 / 1 / 3', 'Top / front / right view'],
      ['Ctrl (or Shift) + 7 / 1 / 3', 'Bottom / back / left view'],
      ['8 / 2', 'Orbit up / down 15°'],
      ['4 / 6', 'Orbit left / right 15°'],
      ['9', 'Flip to the opposite view'],
      ['Numpad or top-row digits', 'Both work (Ctrl + top-row may be taken by the browser)'],
      ['Click a gizmo ball', 'Snap to that view (again → the opposite one)'],
      ['Drag the gizmo', 'Orbit the camera'],
    ],
  },
];

export function KeyboardShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      className={styles.backdrop}
    >
      <div onClick={e => e.stopPropagation()} className={styles.card}>
        <div className={styles.header}>
          <h2 className={styles.heading}>Keyboard shortcuts</h2>
          <button onClick={onClose} aria-label="Close" title="Close (Esc)" className={styles.close}>×</button>
        </div>
        <div className={styles.groups}>
          {GROUPS.map(group => (
            <div key={group.title} className={group.wide ? styles.groupWide : undefined}>
              <div className={styles.groupTitle}>{group.title}</div>
              <dl className={styles.rows}>
                {group.rows.map(([keys, action]) => (
                  <Fragment key={keys}>
                    <dt className={styles.keyCell}><kbd className={styles.kbd}>{keys}</kbd></dt>
                    <dd className={styles.action}>{action}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <div className={styles.footer}>
          Press <kbd className={styles.kbd}>Esc</kbd> to close.
        </div>
      </div>
    </div>
  );
}

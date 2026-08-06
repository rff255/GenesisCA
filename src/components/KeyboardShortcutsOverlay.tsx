/**
 * KeyboardShortcutsOverlay — a quick-reference modal listing the app's
 * keyboard shortcuts and mouse gestures, grouped by area. Opened from the
 * navbar "?" button or the `?` key; closed with Esc, the × button, or a
 * backdrop click. Theme-aware (all colors via CSS variables).
 *
 * This is the discoverability surface for the many keyboard-only actions —
 * the in-app Help tab has the full prose; this is the at-a-glance cheat sheet.
 */

import { useEffect } from 'react';

type Row = [keys: string, action: string];

const GROUPS: { title: string; rows: Row[] }[] = [
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
      ['Ctrl + C / V / X', 'Copy / paste / cut cells'],
      ['Ctrl + wheel', 'Cycle input mappings'],
      ['Ctrl + drag', 'Resize brush (Push / Pull: ↔ radius, ↕ intensity)'],
      ['Shift + click', 'Inspect cell'],
      ['Right-click drag', 'Pan the grid'],
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
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-8)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--panel-radius)',
          boxShadow: 'var(--shadow-lg)',
          maxWidth: 560, width: '100%', maxHeight: '85vh', overflowY: 'auto',
          padding: 'var(--space-8)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-6)' }}>
          <h2 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 500, color: 'var(--color-heading)' }}>Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            style={{
              background: 'transparent', border: '1px solid var(--color-widget-border)',
              borderRadius: 'var(--radius-md)', color: 'var(--color-text-secondary)',
              width: 26, height: 26, cursor: 'pointer', fontSize: 'var(--font-md)', lineHeight: 1,
            }}
          >×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-8)', alignItems: 'start' }}>
          {GROUPS.map(group => (
            <div key={group.title}>
              <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-3)' }}>{group.title}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {group.rows.map(([keys, action]) => (
                    <tr key={keys}>
                      <td style={{ padding: '3px 8px 3px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        <kbd style={{
                          background: 'var(--color-bg-canvas)', border: '1px solid var(--color-widget-border)',
                          borderRadius: 'var(--radius-sm)', padding: '1px 6px',
                          fontFamily: 'var(--font-family-mono)', fontSize: 'var(--font-3xs)',
                          color: 'var(--color-text-secondary)',
                        }}>{keys}</kbd>
                      </td>
                      <td style={{ padding: '3px 0', fontSize: 'var(--font-xs)', color: 'var(--color-text-secondary)' }}>{action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 'var(--space-6)', fontSize: 'var(--font-3xs)', color: 'var(--color-text-tertiary)' }}>
          Press <kbd style={{ background: 'var(--color-bg-canvas)', border: '1px solid var(--color-widget-border)', borderRadius: 'var(--radius-sm)', padding: '0 5px', fontFamily: 'var(--font-family-mono)' }}>Esc</kbd> to close.
        </div>
      </div>
    </div>
  );
}

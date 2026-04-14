import { useEffect } from 'react';
import styles from './SaveProjectDialog.module.css';

export interface SaveOptions {
  includeControls: boolean;
  includeGrid: boolean;
}

interface Props {
  initial: SaveOptions;
  onConfirm: (opts: SaveOptions) => void;
  onCancel: () => void;
  /** Uncontrolled local state is fine for a tiny dialog. Parent re-mounts it each time. */
}

export function SaveProjectDialog({ initial, onConfirm, onCancel }: Props) {
  // Track choices in local state via refs on the checkboxes directly (minimal state).
  // We rely on a small piece of controlled state via a wrapper.
  return <SaveProjectDialogInner initial={initial} onConfirm={onConfirm} onCancel={onCancel} />;
}

function SaveProjectDialogInner({ initial, onConfirm, onCancel }: Props) {
  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') {
        const c = (document.getElementById('save-opt-controls') as HTMLInputElement | null)?.checked ?? initial.includeControls;
        const g = (document.getElementById('save-opt-grid') as HTMLInputElement | null)?.checked ?? initial.includeGrid;
        onConfirm({ includeControls: c, includeGrid: g });
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [initial, onConfirm, onCancel]);

  const handleSave = () => {
    const c = (document.getElementById('save-opt-controls') as HTMLInputElement).checked;
    const g = (document.getElementById('save-opt-grid') as HTMLInputElement).checked;
    onConfirm({ includeControls: c, includeGrid: g });
  };

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>Save Project</div>
        <div className={styles.body}>
          <label className={styles.row}>
            <input id="save-opt-controls" type="checkbox" defaultChecked={initial.includeControls} />
            <div>
              <div className={styles.rowLabel}>Include simulator controls</div>
              <div className={styles.rowHint}>Playback speed, brush size/color, selected input/output mapping, runtime model-attribute values.</div>
            </div>
          </label>
          <label className={styles.row}>
            <input id="save-opt-grid" type="checkbox" defaultChecked={initial.includeGrid} />
            <div>
              <div className={styles.rowLabel}>Include board state</div>
              <div className={styles.rowHint}>Full cell grid snapshot: attributes, generation counter, indicator values, colors.</div>
            </div>
          </label>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={styles.btnPrimary} onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

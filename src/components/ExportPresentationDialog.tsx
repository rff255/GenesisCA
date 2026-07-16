import { useEffect } from 'react';
import styles from './SaveProjectDialog.module.css';

export interface ExportPresentationOptions {
  includeGrid: boolean;
  includeControls: boolean;
}

interface Props {
  initial: ExportPresentationOptions;
  modelName: string;
  /** Grid cell count (W*H*D) — drives the large-board hint. */
  cellCount?: number;
  onConfirm: (opts: ExportPresentationOptions) => void;
  onCancel: () => void;
}

/**
 * Options for exporting a standalone presentation `.html`. Mirrors the Save
 * dialog's board-state / controls semantics; presets + the full model graph +
 * sprites + metadata are ALWAYS embedded (they are the model — a presentation
 * carries everything, in one file).
 */
export function ExportPresentationDialog({ initial, modelName, cellCount = 0, onConfirm, onCancel }: Props) {
  const bigGrid = cellCount > 250_000;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') {
        const g = (document.getElementById('exp-opt-grid') as HTMLInputElement | null)?.checked ?? initial.includeGrid;
        const c = (document.getElementById('exp-opt-controls') as HTMLInputElement | null)?.checked ?? initial.includeControls;
        onConfirm({ includeGrid: g, includeControls: c });
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [initial, onConfirm, onCancel]);

  const handleExport = () => {
    const g = (document.getElementById('exp-opt-grid') as HTMLInputElement).checked;
    const c = (document.getElementById('exp-opt-controls') as HTMLInputElement).checked;
    onConfirm({ includeGrid: g, includeControls: c });
  };

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>Export Presentation</div>
        <div className={styles.body}>
          <p style={{ margin: '0 0 4px', fontSize: 12.5, color: 'var(--color-text-muted, #8a8f9a)' }}>
            Bundles the Simulator + <b style={{ color: 'var(--color-text, #d8dae0)' }}>{modelName || 'this model'}</b> into
            one self-contained <code>.html</code> that runs in any browser — no install, no server. It also carries the
            full editable model (open the <code>.html</code> back in GenesisCA to recover it).
          </p>
          <label className={styles.row}>
            <input id="exp-opt-grid" type="checkbox" defaultChecked={initial.includeGrid} />
            <div>
              <div className={styles.rowLabel}>Include current board state</div>
              <div className={styles.rowHint}>
                The live cell grid so the standalone page opens on exactly the current board.
                {bigGrid && (
                  <span style={{ color: 'var(--color-accent, #e8a13a)' }}>
                    {' '}This grid is large ({cellCount.toLocaleString()} cells) — including it makes a big file, so it starts off.
                  </span>
                )}
              </div>
            </div>
          </label>
          <label className={styles.row}>
            <input id="exp-opt-controls" type="checkbox" defaultChecked={initial.includeControls} />
            <div>
              <div className={styles.rowLabel}>Include simulator controls</div>
              <div className={styles.rowHint}>Playback speed, brush, the selected viewer, and runtime model-attribute values.</div>
            </div>
          </label>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={styles.btnPrimary} onClick={handleExport}>Export .html</button>
        </div>
      </div>
    </div>
  );
}

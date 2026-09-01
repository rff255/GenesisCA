import { useEffect } from 'react';
import styles from './SaveProjectDialog.module.css';

export interface ExportPresentationOptions {
  includeGrid: boolean;
  includeControls: boolean;
  includePresets: boolean;
}

interface Props {
  initial: ExportPresentationOptions;
  modelName: string;
  /** Grid cell count (W*H*D) — drives the large-board hint. */
  cellCount?: number;
  /** How many presets the model carries. 0 hides the presets row entirely —
   *  a checkbox that could not change the exported file either way. */
  presetCount?: number;
  onConfirm: (opts: ExportPresentationOptions) => void;
  onCancel: () => void;
}

/**
 * Options for exporting a standalone presentation `.html`. Mirrors the Save
 * dialog's board-state / controls / presets semantics; the full model graph +
 * sprites + metadata are ALWAYS embedded (they ARE the model — a presentation
 * carries everything, in one file). Presets are the one further opt-out: they
 * are the model's, but a presentation is often a single fixed configuration.
 */
export function ExportPresentationDialog({ initial, modelName, cellCount = 0, presetCount = 0, onConfirm, onCancel }: Props) {
  const bigGrid = cellCount > 250_000;
  const readOpts = (): ExportPresentationOptions => ({
    includeGrid: (document.getElementById('exp-opt-grid') as HTMLInputElement | null)?.checked ?? initial.includeGrid,
    includeControls: (document.getElementById('exp-opt-controls') as HTMLInputElement | null)?.checked ?? initial.includeControls,
    // No row rendered when the model has no presets — there is nothing to strip.
    includePresets: presetCount === 0
      ? false
      : ((document.getElementById('exp-opt-presets') as HTMLInputElement | null)?.checked ?? initial.includePresets),
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm(readOpts());
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [initial, onConfirm, onCancel]);

  const handleExport = () => onConfirm(readOpts());

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>Export standalone simulation</div>
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
          {/* Hidden when the model has no presets: the checkbox could not change
              the exported file either way (the enabled-control rule). */}
          {presetCount > 0 && (
            <label className={styles.row}>
              <input id="exp-opt-presets" type="checkbox" defaultChecked={initial.includePresets} />
              <div>
                <div className={styles.rowLabel}>Include model presets</div>
                <div className={styles.rowHint}>
                  The {presetCount} saved parameter (and optional grid) snapshot{presetCount === 1 ? '' : 's'} viewers
                  can switch between. Leave off for a presentation of one fixed configuration.
                </div>
              </div>
            </label>
          )}
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={styles.btnPrimary} onClick={handleExport}>Export .html</button>
        </div>
      </div>
    </div>
  );
}

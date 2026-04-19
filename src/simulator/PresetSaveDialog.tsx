import { useEffect, useState } from 'react';
import styles from '../components/SaveProjectDialog.module.css';

interface Props {
  onConfirm: (name: string, description: string, includeGrid: boolean) => void;
  onCancel: () => void;
}

export function PresetSaveDialog({ onConfirm, onCancel }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [includeGrid, setIncludeGrid] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && name.trim()) onConfirm(name.trim(), description, includeGrid);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [name, description, includeGrid, onConfirm, onCancel]);

  const canSave = name.trim().length > 0;

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>Save Current as Preset</div>
        <div className={styles.body}>
          <div>
            <div className={styles.rowLabel} style={{ marginBottom: 6 }}>Name</div>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. High threshold"
              style={{
                width: '100%', padding: '6px 8px', background: '#0d1117',
                border: '1px solid #2d4059', borderRadius: 4, color: '#e0e8f0',
                fontSize: '0.78rem', boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <div className={styles.rowLabel} style={{ marginBottom: 6 }}>Description (optional)</div>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What makes this setup interesting?"
              style={{
                width: '100%', padding: '6px 8px', background: '#0d1117',
                border: '1px solid #2d4059', borderRadius: 4, color: '#e0e8f0',
                fontSize: '0.78rem', boxSizing: 'border-box',
              }}
            />
          </div>
          <label className={styles.row}>
            <input type="checkbox" checked={includeGrid}
              onChange={e => setIncludeGrid(e.target.checked)} />
            <div>
              <div className={styles.rowLabel}>Include cell grid state</div>
              <div className={styles.rowHint}>
                Embed the current cells, generation counter, and indicators. Larger file; leave off
                for parameter-only presets that work with any starting grid.
              </div>
            </div>
          </label>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={styles.btnPrimary} disabled={!canSave}
            onClick={() => canSave && onConfirm(name.trim(), description, includeGrid)}>
            Save Preset
          </button>
        </div>
      </div>
    </div>
  );
}

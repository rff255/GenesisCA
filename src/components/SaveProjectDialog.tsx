import { useEffect, useState } from 'react';
import styles from './SaveProjectDialog.module.css';

export interface SaveOptions {
  includeControls: boolean;
  includeGrid: boolean;
  includePresets: boolean;
}

/** The presentation fields the Save dialog lets the user correct on the way out.
 *  They are MODEL properties (the Info panel edits the same three), so a change
 *  here is written back to the model — see FileMenu's doSave. */
export interface SaveMetadata {
  name: string;
  author: string;
  modelAuthor: string;
}

interface Props {
  initial: SaveOptions;
  /** Live model presentation values, read fresh every time the dialog opens
   *  (the parent mounts it conditionally, so the useState seeds are never stale). */
  initialMeta: SaveMetadata;
  onConfirm: (opts: SaveOptions, meta: SaveMetadata) => void;
  onCancel: () => void;
  /** Uncontrolled local state is fine for a tiny dialog. Parent re-mounts it each time. */
}

export function SaveProjectDialog({ initial, initialMeta, onConfirm, onCancel }: Props) {
  // Track choices in local state via refs on the checkboxes directly (minimal state).
  // We rely on a small piece of controlled state via a wrapper.
  return (
    <SaveProjectDialogInner
      initial={initial}
      initialMeta={initialMeta}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function SaveProjectDialogInner({ initial, initialMeta, onConfirm, onCancel }: Props) {
  const [name, setName] = useState(initialMeta.name);
  const [author, setAuthor] = useState(initialMeta.author);
  const [modelAuthor, setModelAuthor] = useState(initialMeta.modelAuthor);
  // An empty name would strip the navbar title AND collapse the derived filename
  // to `model.gcaproj`, so Save is barred until the field carries something.
  const canSave = name.trim().length > 0;

  const readOpts = (): SaveOptions => ({
    includeControls: (document.getElementById('save-opt-controls') as HTMLInputElement | null)?.checked ?? initial.includeControls,
    includeGrid: (document.getElementById('save-opt-grid') as HTMLInputElement | null)?.checked ?? initial.includeGrid,
    includePresets: (document.getElementById('save-opt-presets') as HTMLInputElement | null)?.checked ?? initial.includePresets,
  });
  const readMeta = (): SaveMetadata => ({
    name: name.trim(),
    author: author.trim(),
    modelAuthor: modelAuthor.trim(),
  });

  // Close on Escape / confirm on Enter. Deliberately re-registered every render:
  // the handler closes over the live field values, and a listener swap is far
  // cheaper than threading refs through a dialog this small.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') {
        if (!canSave) return;
        onConfirm(readOpts(), readMeta());
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const handleSave = () => {
    if (!canSave) return;
    onConfirm(readOpts(), readMeta());
  };

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>Save Project</div>
        <div className={styles.body}>
          <div className={styles.fields}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="save-meta-name">Name</label>
              <input
                id="save-meta-name"
                className={styles.textInput}
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="save-meta-author">Rule Author</label>
              <input
                id="save-meta-author"
                className={styles.textInput}
                type="text"
                value={author}
                placeholder="Originator of the CA rule"
                onChange={e => setAuthor(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="save-meta-model-author">GenesisCA Project Author</label>
              <input
                id="save-meta-model-author"
                className={styles.textInput}
                type="text"
                value={modelAuthor}
                placeholder="Who built this GenesisCA project"
                onChange={e => setModelAuthor(e.target.value)}
              />
            </div>
            <div className={styles.fieldsHint}>
              Edits here are written back to the model, not just to the saved file.
            </div>
          </div>
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
          <label className={styles.row}>
            <input id="save-opt-presets" type="checkbox" defaultChecked={initial.includePresets} />
            <div>
              <div className={styles.rowLabel}>Include model presets</div>
              <div className={styles.rowHint}>Saved parameter (and optional grid) snapshots users can switch between in the Simulator.</div>
            </div>
          </label>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button
            className={styles.btnPrimary}
            disabled={!canSave}
            title={canSave ? undefined : 'The model needs a name'}
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

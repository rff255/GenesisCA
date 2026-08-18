import { useEffect, useState } from 'react';
import styles from './SaveProjectDialog.module.css';

export interface SaveOptions {
  includeControls: boolean;
  includeGrid: boolean;
  includePresets: boolean;
}

/** The MODEL properties the Save dialog lets the user set on the way out — the
 *  three presentation fields (the Info panel edits the same three) plus, when a
 *  board is being included, whether that board is this model's INITIAL state. A
 *  change here is written back to the model, not only to the file — see
 *  FileMenu's doSave. */
export interface SaveMetadata {
  name: string;
  author: string;
  modelAuthor: string;
  /** `properties.resetRestoresBoard`. Meaningful only alongside
   *  `includeGrid` — `undefined` means "leave the model's value alone" (the
   *  board is not being saved, so there would be nothing to restore). */
  resetRestoresBoard?: boolean;
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
  // "Include board state" is CONTROLLED (the other two rows stay uncontrolled):
  // the sub-row below only exists while a board is actually being saved, so it
  // has to re-render when this box is ticked.
  const [grid, setGrid] = useState(initial.includeGrid);
  const [initialState, setInitialState] = useState(initialMeta.resetRestoresBoard === true);
  // An empty name would strip the navbar title AND collapse the derived filename
  // to `model.gcaproj`, so Save is barred until the field carries something.
  const canSave = name.trim().length > 0;

  const readOpts = (): SaveOptions => ({
    includeControls: (document.getElementById('save-opt-controls') as HTMLInputElement | null)?.checked ?? initial.includeControls,
    includeGrid: grid,
    includePresets: (document.getElementById('save-opt-presets') as HTMLInputElement | null)?.checked ?? initial.includePresets,
  });
  const readMeta = (): SaveMetadata => ({
    name: name.trim(),
    author: author.trim(),
    modelAuthor: modelAuthor.trim(),
    // Only meaningful when a board is actually saved: with the grid left out,
    // the file carries no board to restore, so the model's flag is left alone.
    resetRestoresBoard: grid ? initialState : undefined,
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
                placeholder="Originator of the rule/formalism/paper"
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
            <input id="save-opt-grid" type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)} />
            <div>
              <div className={styles.rowLabel}>Include board state</div>
              {/* Truthful list: serializeSimState writes cell attributes, colors, the
                  async order array and — for an agent model — the agent population,
                  and DELIBERATELY skips generation + indicators (a saved board is a
                  starting configuration, not a run snapshot). */}
              <div className={styles.rowHint}>Full board snapshot: cell attributes, colors, and the agent population.</div>
            </div>
          </label>
          {/* Only while a board is actually being saved — otherwise the file would
              carry no board and the flag nothing to restore. It edits a MODEL
              property (Properties → Execution shows the same checkbox). */}
          {grid && (
            <label className={`${styles.row} ${styles.subRow}`}>
              <input type="checkbox" checked={initialState} onChange={e => setInitialState(e.target.checked)} />
              <div>
                <div className={styles.rowLabel}>Use as initial state (Reset restores this board)</div>
                <div className={styles.rowHint}>
                  For a board that is DATA — imported map layers, a hand-painted starting configuration — which no
                  Init Event can regenerate. The simulator&apos;s ■ Reset button still offers both actions on hover.
                </div>
              </div>
            </label>
          )}
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

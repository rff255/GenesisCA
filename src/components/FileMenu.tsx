import { useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import {
  serializeModel,
  modelFilename,
  downloadJSON,
  readModelFile,
} from '../model/fileOperations';
import { SaveProjectDialog, type SaveOptions } from './SaveProjectDialog';
import styles from './FileMenu.module.css';

const SAVE_OPTS_KEY = 'genesisca_save_options';

function loadSaveOptions(): SaveOptions {
  try {
    const raw = localStorage.getItem(SAVE_OPTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        includeControls: parsed.includeControls !== false,
        includeGrid: parsed.includeGrid !== false,
      };
    }
  } catch { /* ignore */ }
  return { includeControls: true, includeGrid: true };
}

export function FileMenu() {
  const { model, isDirty, newModel, loadModel, markSaved } = useModel();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  const handleNew = () => {
    if (isDirty && !window.confirm('You have unsaved changes. Create a new model?')) {
      return;
    }
    newModel();
  };

  const handleSave = () => {
    setSaveDialogOpen(true);
  };

  const doSave = async (opts: SaveOptions) => {
    setSaveDialogOpen(false);
    try {
      localStorage.setItem(SAVE_OPTS_KEY, JSON.stringify(opts));
    } catch { /* ignore */ }

    // Ask simulator to capture the requested pieces into model context and wait
    const captured = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => resolve(false), 5000);
      window.dispatchEvent(new CustomEvent('genesis-capture-sim-state', {
        detail: {
          resolve: () => { clearTimeout(timeout); resolve(true); },
          include: { grid: opts.includeGrid, controls: opts.includeControls },
        },
      }));
    });
    void captured;
    // Wait one frame so React state updates have settled
    await new Promise(r => requestAnimationFrame(r));
    const latest = modelRef.current;
    // If user opted out of both, strip simulationState entirely regardless of what's in model
    const toSerialize = (!opts.includeControls && !opts.includeGrid)
      ? { ...latest, simulationState: undefined }
      : latest;
    const json = serializeModel(toSerialize);
    const filename = modelFilename(latest);
    downloadJSON(json, filename);
    markSaved();
  };

  const handleLoad = () => {
    if (isDirty && !window.confirm('You have unsaved changes. Load a different model?')) {
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await readModelFile(file);
      loadModel(parsed);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load file.');
    }
    e.target.value = '';
  };

  return (
    <div className={styles.fileMenu}>
      <button className={styles.menuButton} onClick={handleNew}>
        New
      </button>
      <button className={styles.menuButton} onClick={handleSave}>
        Save
      </button>
      <button className={styles.menuButton} onClick={handleLoad}>
        Load
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".gcaproj,.json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      {saveDialogOpen && (
        <SaveProjectDialog
          initial={loadSaveOptions()}
          onConfirm={doSave}
          onCancel={() => setSaveDialogOpen(false)}
        />
      )}
    </div>
  );
}

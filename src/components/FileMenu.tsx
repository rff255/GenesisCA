import { useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import {
  serializeModel,
  modelFilename,
  downloadJSON,
  readModelFile,
} from '../model/fileOperations';
import type { SimulationState } from '../model/types';
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
        includePresets: parsed.includePresets !== false,
      };
    }
  } catch { /* ignore */ }
  return { includeControls: true, includeGrid: true, includePresets: true };
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

    // Ask simulator to capture the requested pieces into model context and wait.
    // The simulator passes the captured SimulationState back through the resolve
    // callback so we can serialise it DIRECTLY without waiting for React to
    // re-render — bypassing a race where modelRef.current would still hold the
    // pre-capture model if React hadn't flushed yet.
    const captured = await new Promise<SimulationState | null | undefined>(resolve => {
      const timeout = setTimeout(() => resolve(undefined), 5000);
      window.dispatchEvent(new CustomEvent('genesis-capture-sim-state', {
        detail: {
          resolve: (state: SimulationState | null = null) => {
            clearTimeout(timeout);
            resolve(state);
          },
          include: { grid: opts.includeGrid, controls: opts.includeControls },
        },
      }));
    });
    const latest = modelRef.current;
    // If user opted out of both, strip simulationState entirely regardless of what's in model
    const wantsAny = opts.includeControls || opts.includeGrid;
    // Prefer the captured state passed back through the event (bypasses React's
    // render cycle). Fall back to modelRef.current.simulationState only if the
    // simulator didn't pass one (e.g. timed out or no worker).
    const stateForFile = wantsAny
      ? (captured ?? latest.simulationState)
      : undefined;
    let toSerialize = { ...latest, simulationState: stateForFile };
    if (!opts.includePresets) {
      toSerialize = { ...toSerialize, presets: undefined };
    }
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

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
import { ConfirmDialog } from './ConfirmDialog';
import styles from './FileMenu.module.css';

/** Confirm dialog payload — set when an action needs user confirmation
 *  before proceeding. onConfirm runs the deferred action; setting state to
 *  null dismisses. Keeps render markup simple (one optional ConfirmDialog). */
type PendingConfirm =
  | { title: string; message: string; confirmLabel: string; onConfirm: () => void }
  | null;

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

export function FileMenu({ onNew, onLoaded }: {
  onNew?: () => void;
  /** Called after a .gcaproj file loads successfully (App switches to the
   *  Simulator tab and shows the load-confirmation toast). */
  onLoaded?: (modelName: string) => void;
} = {}) {
  const { model, isDirty, newModel, loadModel, markSaved } = useModel();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);

  const handleNew = () => {
    if (isDirty) {
      setPendingConfirm({
        title: 'Discard unsaved changes?',
        message: 'You have unsaved changes that will be lost if you create a new model.',
        confirmLabel: 'Create new',
        onConfirm: () => { setPendingConfirm(null); newModel(); onNew?.(); },
      });
      return;
    }
    newModel();
    onNew?.();
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
    markSaved(filename);
  };

  const handleLoad = () => {
    if (isDirty) {
      setPendingConfirm({
        title: 'Discard unsaved changes?',
        message: 'You have unsaved changes that will be lost if you load a different model.',
        confirmLabel: 'Load',
        onConfirm: () => { setPendingConfirm(null); fileInputRef.current?.click(); },
      });
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await readModelFile(file);
      loadModel(parsed, file.name);
      onLoaded?.(parsed.properties?.name ?? 'Model');
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
      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          danger
          onConfirm={pendingConfirm.onConfirm}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}

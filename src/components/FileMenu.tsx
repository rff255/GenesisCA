import { useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import {
  serializeModel,
  modelFilename,
  downloadJSON,
  readModelFile,
} from '../model/fileOperations';
import type { SimulationState, CAModel } from '../model/types';
import { SaveProjectDialog, type SaveOptions } from './SaveProjectDialog';
import { ConfirmDialog } from './ConfirmDialog';
import styles from './FileMenu.module.css';

/** Confirm dialog payload — set when an action needs user confirmation
 *  before proceeding. onConfirm runs the deferred action; setting state to
 *  null dismisses. Keeps render markup simple (one optional ConfirmDialog). */
type PendingConfirm =
  | { title: string; message: string; confirmLabel: string; onConfirm: () => void }
  | null;

/** Default the Save-dialog checkboxes per-LOADED-MODEL instead of from the last
 *  global choice the program made — which used to leak across models and
 *  silently drop data (the reported bug: loading a model WITH presets, tweaking
 *  its description, then saving with the presets box unchecked because a PRIOR
 *  save of a different model had omitted them).
 *
 *  - Presets are a durable model property: check the box iff the model actually
 *    HAS presets, so a save never drops the presets a loaded model carries (and
 *    never offers "include presets" for a model that has none).
 *  - Board state + simulator controls are LIVE-session captures. When the model
 *    carries an embedded snapshot, reflect its composition — `serializeSimState`
 *    writes `attributes` only in its grid branch and `modelAttrs` only in its
 *    controls branch, so their presence records which layers were last saved for
 *    THIS model (and respects a prior explicit omission). When there is NO
 *    embedded snapshot (a fresh/from-scratch model, or one saved
 *    definition-only) there is no per-model history to reflect, so default both
 *    ON — matching the historical convenience default so that building a model
 *    from scratch, evolving its board / tuning its attributes, and hitting Save
 *    still captures that live work rather than silently discarding it. */
function deriveSaveOptions(model: CAModel): SaveOptions {
  const s = model.simulationState;
  return {
    includeGrid: s ? s.attributes !== undefined : true,
    includeControls: s ? s.modelAttrs !== undefined : true,
    includePresets: (model.presets?.length ?? 0) > 0,
  };
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
  // File dropdown open state. Closes on any outside press or Escape.
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The dropdown is position:fixed (measured from the trigger) so it is NOT
  // clipped by the navbar's `.navLeft { overflow: hidden }`.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const toggleMenu = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: Math.round(r.bottom + 4), left: Math.round(r.left) });
    }
    setOpen(o => !o);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  /** Close the menu, then run the chosen action. */
  const runItem = (fn: () => void) => { setOpen(false); fn(); };

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
    // Native (Tauri) shows a Save As dialog; only mark saved if the user picked
    // a path (didn't cancel). Browser download always resolves true.
    const saved = await downloadJSON(json, filename);
    if (saved) markSaved(filename);
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
    <div className={styles.fileMenu} ref={menuRef}>
      <button
        ref={triggerRef}
        className={`${styles.menuButton} ${open ? styles.menuButtonActive : ''}`}
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        File
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open && menuPos && (
        <div className={styles.dropdown} role="menu" style={{ top: menuPos.top, left: menuPos.left }}>
          <button className={styles.dropdownItem} role="menuitem" onClick={() => runItem(handleNew)}>New</button>
          <button className={styles.dropdownItem} role="menuitem" onClick={() => runItem(handleSave)}>Save</button>
          <button className={styles.dropdownItem} role="menuitem" onClick={() => runItem(handleLoad)}>Load</button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".gcaproj,.json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      {saveDialogOpen && (
        <SaveProjectDialog
          initial={deriveSaveOptions(model)}
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

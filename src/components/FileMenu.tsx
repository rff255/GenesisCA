import { useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import {
  serializeModel,
  modelFilename,
  downloadJSON,
  downloadHTML,
  readModelFile,
} from '../model/fileOperations';
import { buildPresentationHtml, presentationFilename } from '../export/exportPresentation';
import type { SimulationState, CAModel, ModelProperties } from '../model/types';
import { SaveProjectDialog, type SaveOptions, type SaveMetadata } from './SaveProjectDialog';
import { ExportPresentationDialog, type ExportPresentationOptions } from './ExportPresentationDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { NewModelDialog } from './NewModelDialog';
import { buildArchetypeModel, type ArchetypeId } from '../model/archetypes';
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
 *  Used only for the FIRST save of a loaded/new model: once the user confirms a
 *  save, the chosen options are remembered on ModelState (lastSaveOptions, reset
 *  on New/Load) and the dialog re-opens with THOSE — so repeated saves keep the
 *  user's explicit choice (all boxes off stays all off) instead of re-deriving
 *  from the file content each time.
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
  const { model, isDirty, newModel, loadModel, markSaved, lastSaveOptions, updateProperties } = useModel();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
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

  /** C7 (P6): New opens the archetype chooser — AFTER the unsaved-changes
   *  confirmation, so the destructive confirmation still guards the destructive
   *  act and cancelling the chooser keeps the current model even though the
   *  confirm was already accepted. (Ordering it the other way would ask the user
   *  to make a choice that might then be thrown away.) */
  const handleNew = () => {
    if (isDirty) {
      setPendingConfirm({
        title: 'Discard unsaved changes?',
        message: 'You have unsaved changes that will be lost if you create a new model.',
        confirmLabel: 'Create new',
        onConfirm: () => { setPendingConfirm(null); setNewDialogOpen(true); },
      });
      return;
    }
    setNewDialogOpen(true);
  };

  /** `'empty'` builds EMPTY_MODEL verbatim, so the historical New is one click. */
  const doCreateArchetype = (id: ArchetypeId) => {
    setNewDialogOpen(false);
    newModel(buildArchetypeModel(id));
    onNew?.();
  };

  const handleSave = () => {
    setSaveDialogOpen(true);
  };

  const doSave = async (opts: SaveOptions, meta: SaveMetadata) => {
    setSaveDialogOpen(false);

    // The dialog's Name / Rule Author / Project Author fields edit MODEL
    // properties (the same three the Info panel owns), so a change made on the
    // way out must land in the app state too — not only in the written file.
    // `updateProperties` is a dispatch (async React state), so reading `model`
    // back here would still see the pre-edit values: build the edits ONCE, hand
    // them to the reducer AND fold them into the object we serialize, so the
    // file and the app can never disagree. An empty name is barred by the
    // dialog, so `metaEdits.name` is only ever a real replacement.
    const metaEdits: Partial<ModelProperties> = {};
    {
      const p = modelRef.current.properties;
      if (meta.name && meta.name !== p.name) metaEdits.name = meta.name;
      if (meta.author !== (p.author ?? '')) metaEdits.author = meta.author;
      if (meta.modelAuthor !== (p.modelAuthor ?? '')) metaEdits.modelAuthor = meta.modelAuthor;
    }
    const hasMetaEdits = Object.keys(metaEdits).length > 0;
    if (hasMetaEdits) updateProperties(metaEdits);

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
    let toSerialize: CAModel = { ...latest, simulationState: stateForFile };
    if (hasMetaEdits) {
      toSerialize = { ...toSerialize, properties: { ...toSerialize.properties, ...metaEdits } };
    }
    if (!opts.includePresets) {
      toSerialize = { ...toSerialize, presets: undefined };
    }
    const json = serializeModel(toSerialize);
    // Derive the default filename from the EDITED name, not the stale one.
    const filename = modelFilename(toSerialize);
    // Native (Tauri) shows a Save As dialog; only mark saved if the user picked
    // a path (didn't cancel). Browser download always resolves true.
    const saved = await downloadJSON(json, filename);
    // Remember the confirmed include-choices for THIS loaded model so the next
    // save re-opens with them (repeated saves keep the user's choice — e.g. all
    // boxes off STAYS all off, instead of the content-derived defaults
    // re-checking grid+controls every time). Reset on New/Load.
    if (saved) markSaved(filename, opts);
  };

  const handleExport = () => {
    setExportDialogOpen(true);
  };

  const doExport = async (opts: ExportPresentationOptions) => {
    setExportDialogOpen(false);
    // Capture the requested live state (same seam as Save). Presets + the full
    // model graph + sprites + metadata are always embedded by serializeModel.
    const captured = await new Promise<SimulationState | null | undefined>(resolve => {
      const timeout = setTimeout(() => resolve(undefined), 5000);
      window.dispatchEvent(new CustomEvent('genesis-capture-sim-state', {
        detail: {
          resolve: (state: SimulationState | null = null) => { clearTimeout(timeout); resolve(state); },
          include: { grid: opts.includeGrid, controls: opts.includeControls },
        },
      }));
    });
    const latest = modelRef.current;
    const wantsAny = opts.includeGrid || opts.includeControls;
    const stateForFile = wantsAny ? (captured ?? latest.simulationState) : undefined;
    const modelForExport = { ...latest, simulationState: stateForFile };
    try {
      const html = await buildPresentationHtml(modelForExport);
      await downloadHTML(html, presentationFilename(latest));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Export failed.');
    }
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
          <button className={styles.dropdownItem} role="menuitem" onClick={() => runItem(handleExport)}>Export standalone simulation…</button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".gcaproj,.json,.html,.htm"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      {saveDialogOpen && (
        <SaveProjectDialog
          initial={lastSaveOptions ?? deriveSaveOptions(model)}
          initialMeta={{
            name: model.properties.name ?? '',
            author: model.properties.author ?? '',
            modelAuthor: model.properties.modelAuthor ?? '',
          }}
          onConfirm={doSave}
          onCancel={() => setSaveDialogOpen(false)}
        />
      )}
      {exportDialogOpen && (() => {
        const p = model.properties;
        const cellCount = (p.gridWidth || 0) * (p.gridHeight || 0) * (p.gridDepth ?? 1);
        // A big embedded board dominates the exported file (base64 typed arrays),
        // so default it OFF past a threshold — the model + metadata still export.
        const bigGrid = cellCount > 250_000;
        const derived = deriveSaveOptions(model);
        return (
          <ExportPresentationDialog
            initial={{ includeGrid: bigGrid ? false : derived.includeGrid, includeControls: derived.includeControls }}
            modelName={p.name}
            cellCount={cellCount}
            onConfirm={doExport}
            onCancel={() => setExportDialogOpen(false)}
          />
        );
      })()}
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
      {newDialogOpen && (
        <NewModelDialog
          onCreate={doCreateArchetype}
          onCancel={() => setNewDialogOpen(false)}
        />
      )}
    </div>
  );
}

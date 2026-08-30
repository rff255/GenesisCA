import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ModelProvider, useModel } from './model/ModelContext';
import { readModelFile } from './model/fileOperations';
import { registerSW } from 'virtual:pwa-register';
import { FileMenu } from './components/FileMenu';
import { InstallButton } from './components/InstallButton';
import { navIconBtn } from './components/navStyles';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ModelerView } from './modeler/ModelerView';
import { SimulatorView } from './simulator/SimulatorView';
import { HelpView } from './help/HelpView';
import { ModelsLibrary } from './library/ModelsLibrary';
import { StyleReferenceView } from './styleguide/StyleReferenceView';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { KeyboardShortcutsOverlay } from './components/KeyboardShortcutsOverlay';
import { BusyOverlay, useBusy } from './components/BusyOverlay';
import { beginBusy } from './components/busyState';
import { setPendingMacroImport } from './modeler/vpl/graphState';
import type { CAModel } from './model/types';
import styles from './App.module.css';

type AppMode = 'modeler' | 'simulator' | 'help' | 'library' | 'styleref';

/** How often an installed (long-lived) session asks the SW to look for a new
 *  build. Only fires while online; a page load / return-to-foreground checks too. */
const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/* The two work-MODE tabs carry icons — they're the most important structural
 * switch in the app, so they read as a pair of glyphs rather than two words in a
 * row of words. Stroked `currentColor` at 14px, matching the ActivityBar /
 * navbar SVG vocabulary, so the active/inactive + per-theme colors apply for
 * free. Small enough (14 < the ~15px text line box) that the buttons don't grow. */
const modeIcon = (children: ReactNode) => (
  <svg
    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    {children}
  </svg>
);
/** Modeler — a node graph: two boxes joined by an elbow wire. */
const MODELER_ICON = modeIcon(
  <><rect x="2.5" y="3.5" width="8" height="6" rx="1.5" /><rect x="13.5" y="14.5" width="8" height="6" rx="1.5" /><path d="M10.5 6.5h1.5a2.5 2.5 0 0 1 2.5 2.5v8.5" /></>,
);
/** Simulator — a canvas with a play triangle: run the model. */
const SIMULATOR_ICON = modeIcon(
  <><rect x="2.5" y="4" width="19" height="16" rx="2" /><polygon points="10,9 15.5,12 10,15" fill="currentColor" stroke="none" /></>,
);

function AppInner() {
  // Every tab/reload lands on the Library — it's the natural starting point for
  // picking a model to explore or fork.
  const [mode, setMode] = useState<AppMode>('library');
  const { model, isDirty, loadedFileName, loadModel } = useModel();
  // Live dirty-state ref for the once-registered file-handler consumer (below),
  // which would otherwise capture a stale isDirty from mount.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  // Pending library-load that's waiting for an unsaved-changes confirmation.
  // Holds the requested model so the deferred onConfirm has a closed-over
  // reference; setting to null dismisses the dialog.
  const [pendingLibLoad, setPendingLibLoad] = useState<{ model: CAModel; fileName?: string } | null>(null);
  // Pending .gcastate drop awaiting the replace-state confirmation.
  const [pendingStateDrop, setPendingStateDrop] = useState<File | null>(null);
  // File-drag-over-the-window indicator (drives the drop overlay). Counter-based
  // (dragenter/dragleave fire per-element as the drag crosses children).
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  // Transient load-confirmation toast (auto-dismisses).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (msg: string) => {
    if (toastTimer.current != null) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };
  useEffect(() => () => { if (toastTimer.current != null) clearTimeout(toastTimer.current); }, []);
  // The busy/progress card shares the toast's top-centre slot. When one is up,
  // the toast steps down so both stay readable (they DO coincide: the "loaded
  // successfully" toast fires while the worker is still reinitialising).
  const busy = useBusy();

  // A newer service worker is installed and WAITING — drives the update banner.
  const [updateReady, setUpdateReady] = useState(false);
  // The registerSW() callback: updateSW(true) = skipWaiting + reload. Held in a
  // ref because it only exists after the (once-only) registration effect runs.
  const updateSWRef = useRef<((reload?: boolean) => Promise<void>) | null>(null);
  const swUpdateTimerRef = useRef<number | null>(null);
  const swVisibilityCleanupRef = useRef<(() => void) | null>(null);

  // Register the offline service worker + request durable storage. Update
  // strategy is 'prompt' (vite.config): the new SW installs but WAITS, so a
  // fresh deploy NEVER force-reloads a live session on its own (autoUpdate's
  // mid-session page reload was wiping the user's open model). onNeedRefresh
  // surfaces the waiting SW as a dismissible banner — the reload happens ONLY
  // when the user clicks Update; dismissing leaves it to apply on the next
  // natural launch. No "offline ready" toast (the app ALWAYS works offline, so
  // announcing it is noise).
  useEffect(() => {
    // The service worker is for the WEB PWA ONLY. Inside the Tauri native shell
    // (WebView2) the app's assets are already embedded + offline, and a SW there
    // caches the whole app into WebView2's PERSISTENT profile, then serves that
    // STALE copy on every launch — so a freshly-built exe shows the OLD UI/models
    // (the v1.19.x "stale exe" bug). So: register the SW on the web; in Tauri,
    // UNREGISTER any prior SW + drop its caches so the embedded build always wins.
    if ('__TAURI_INTERNALS__' in window) {
      navigator.serviceWorker?.getRegistrations?.()
        .then(rs => rs.forEach(r => r.unregister())).catch(() => {});
      if (typeof caches !== 'undefined') {
        caches.keys?.().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
      }
    } else {
      updateSWRef.current = registerSW({
        immediate: true,
        onNeedRefresh: () => setUpdateReady(true),
        // registerSW({immediate}) checks for a new SW on every page load, which
        // is enough for a browser tab — but an INSTALLED PWA is often left open
        // for days, so poll too. Guarded on navigator.onLine (a check while
        // offline is a guaranteed-failing network request), and re-checked when
        // the app comes back to the foreground, which is when a phone/laptop
        // that slept through the interval regains connectivity.
        onRegisteredSW: (_swUrl, registration) => {
          if (!registration) return;
          const check = () => {
            if (navigator.onLine) registration.update().catch(() => {});
          };
          swUpdateTimerRef.current = window.setInterval(check, SW_UPDATE_INTERVAL_MS);
          const onVisible = () => { if (document.visibilityState === 'visible') check(); };
          document.addEventListener('visibilitychange', onVisible);
          swVisibilityCleanupRef.current = () => document.removeEventListener('visibilitychange', onVisible);
        },
      });
      // Auto-granted once installed; keeps the offline cache from being evicted
      // under disk pressure. Storage durability only — does NOT raise the memory
      // ceiling for large grids; neither does the current Tauri shell (same
      // Chromium/WebView2 engine) — only a native-Rust simulation would.
      navigator.storage?.persist?.().catch(() => {});
      // DEV hook: onNeedRefresh only fires when a genuinely newer SW installs,
      // which can't be staged from a dev server — so expose the same state flip
      // to drive/verify the banner (the project's `window.__*` DEV-hook rule).
      if (import.meta.env.DEV) {
        (window as unknown as { __pwaTestNeedRefresh?: () => void }).__pwaTestNeedRefresh =
          () => setUpdateReady(true);
      }
    }
    // Fade out + remove the static boot splash (index.html) now that React has
    // mounted and the app shell is on screen.
    const splash = document.getElementById('splash');
    let splashTimer: number | null = null;
    if (splash) {
      splash.classList.add('splash-hide');
      splashTimer = window.setTimeout(() => splash.remove(), 400);
    }
    return () => {
      if (splashTimer != null) clearTimeout(splashTimer);
      if (swUpdateTimerRef.current != null) clearInterval(swUpdateTimerRef.current);
      swVisibilityCleanupRef.current?.();
    };
  }, []);

  // Keyboard-shortcuts cheat-sheet overlay, surfaced as a navbar `?` button so
  // the (otherwise keyboard-only) action is discoverable from any view. The
  // canvas-fullscreen toggle (F) now lives ON each canvas — GraphEditor's
  // view-toggle cluster and SimulatorView's zoom controls — which dispatch the
  // `genesis-toggle-canvas-fullscreen` event those views already listen for.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // `?` (Shift+/) opens the shortcuts overlay — but not while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      e.preventDefault();
      setShortcutsOpen(o => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** Shared post-load flow: land in the Simulator, confirm the load. */
  const afterLoad = (modelName: string) => {
    setMode('simulator');
    showToast(`Model "${modelName}" loaded successfully.`);
  };

  const handleLoadLibraryModel = (model: CAModel, fileName?: string) => {
    if (isDirty) { setPendingLibLoad({ model, fileName }); return; }
    loadModel(model, fileName);
    afterLoad(model.properties.name);
  };

  // --- Drag-and-drop files anywhere on the app -----------------------------
  // .gcaproj / .json / presentation .html → the SAME confirm-load flow as
  // FileMenu / the PWA file handler (readModelFile auto-detects HTML; unsaved
  // changes go through pendingLibLoad). .gcastate → confirm, then replace the
  // sim state via a genesis-load-state-file CustomEvent SimulatorView handles
  // (the exact transport-bar Load State path). .gcapreset → append to the
  // model's presets (genesis-import-preset-file). .gcamacro → the graph
  // editor's macro import (see the branch below). Images → the Map Image to
  // Cells dialog (genesis-open-image-file — the Ctrl+V clipboard seam).
  // .csv / .tsv / .asc → the Import CSV dialog (genesis-open-csv-file); an Esri
  // ASCII grid takes the same seam and reshapes the dialog from its own header.
  // .geojson → the GeoJSON vector dialog (genesis-open-geojson-file).
  // Window-level listeners preventDefault dragover+drop so the browser never
  // navigates to a dropped file.
  const loadDroppedProject = async (file: File) => {
    // Reading + parsing a .gcaproj is the one main-thread half of a model load
    // (a big embedded simulationState or thumbnail makes it seconds); the worker
    // reinit that follows announces itself separately from SimulatorView.
    const busyHandle = beginBusy(`Loading "${file.name}"…`);
    try {
      const parsed = await readModelFile(file);
      if (isDirtyRef.current) {
        setPendingLibLoad({ model: parsed, fileName: file.name });
      } else {
        loadModel(parsed, file.name);
        afterLoad(parsed.properties?.name ?? 'Model');
      }
    } catch (err) {
      showToast(`Could not open "${file.name}": ${err instanceof Error ? err.message : 'invalid project file'}`);
    } finally {
      busyHandle.end();
    }
  };
  const handleDroppedFile = (file: File, clientX?: number, clientY?: number) => {
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (['gcaproj', 'json', 'html', 'htm'].includes(ext)) { void loadDroppedProject(file); return; }
    if (ext === 'gcastate') { setPendingStateDrop(file); return; }
    if (ext === 'gcapreset') {
      window.dispatchEvent(new CustomEvent('genesis-import-preset-file', { detail: { file } }));
      showToast(`Importing preset from "${file.name}"…`);
      return;
    }
    // .gcamacro → the graph editor's macro-import flow — the SAME logic the
    // canvas "Import Macro…" menu item runs (parseMacroFile → planImport → the
    // M2 resolution dialog when the file carries references, straight through
    // when it does not). The editor is UNMOUNTED on every non-Modeler tab, so
    // the file is stashed in a module-level slot that survives the tab switch
    // and drained by GraphEditor on mount OR from the event, whichever comes
    // first (takePendingMacroImport makes the loser a no-op). The drop coords
    // are carried only when the Modeler was ALREADY active — otherwise the drop
    // landed on some other view and the editor places the macro at its
    // viewport centre instead.
    if (ext === 'gcamacro') {
      setPendingMacroImport(
        mode === 'modeler' ? { file, clientX, clientY } : { file },
      );
      setMode('modeler');
      window.dispatchEvent(new CustomEvent('genesis-import-macro-file'));
      return;
    }
    // .asc (Esri ASCII grid) rides the SAME dialog — it decides its own shape
    // from the file's header.
    if (['csv', 'tsv', 'asc'].includes(ext)) {
      setMode('simulator');
      window.dispatchEvent(new CustomEvent('genesis-open-csv-file', { detail: { file } }));
      return;
    }
    // .geojson → the GeoJSON vector dialog. Deliberately NOT bare `.json`: that
    // extension is already a GenesisCA project here, and a drop has no dialog in
    // which to disambiguate. A GeoJSON saved as `.json` goes through the transport
    // bar's "Import GeoJSON…" item instead, whose picker accepts it and sniffs.
    if (ext === 'geojson') {
      setMode('simulator');
      window.dispatchEvent(new CustomEvent('genesis-open-geojson-file', { detail: { file } }));
      return;
    }
    // .tif / .tiff → the GeoTIFF dialog. Checked BEFORE the image branch below:
    // a TIFF is an image by MIME, but a georeferenced raster belongs in the band
    // → attribute importer, not the colour-mapping one.
    if (['tif', 'tiff'].includes(ext)) {
      setMode('simulator');
      window.dispatchEvent(new CustomEvent('genesis-open-geotiff-file', { detail: { file } }));
      return;
    }
    if (file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'bmp', 'webp'].includes(ext)) {
      setMode('simulator');
      window.dispatchEvent(new CustomEvent('genesis-open-image-file', { detail: { file } }));
      return;
    }
    showToast(`Unsupported file type: "${file.name}"`);
  };
  // Latest-ref so the once-registered listeners never act on a stale closure.
  const handleDroppedFileRef = useRef(handleDroppedFile);
  handleDroppedFileRef.current = handleDroppedFile;
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      dragDepth.current = 0;
      setDragActive(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) handleDroppedFileRef.current(file, e.clientX, e.clientY);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OS file association: when GenesisCA is launched by opening a .gcaproj — the
  // PWA File Handling API, declared via manifest `file_handlers` — load that
  // project. Chromium desktop + installed PWA only; a no-op everywhere else
  // (browser tab, Firefox, Safari). Registered once; isDirtyRef keeps the
  // unsaved-changes guard live for warm launches into an already-open app.
  useEffect(() => {
    const lq = (window as unknown as {
      launchQueue?: { setConsumer: (cb: (p: { files: FileSystemFileHandle[] }) => void) => void };
    }).launchQueue;
    if (!lq) return;
    lq.setConsumer(async ({ files }) => {
      const handle = files && files[0];
      if (!handle) return;
      const busyHandle = beginBusy('Loading model…');
      try {
        const file = await handle.getFile();
        const parsed = await readModelFile(file);
        if (isDirtyRef.current) {
          setPendingLibLoad({ model: parsed, fileName: file.name });
        } else {
          loadModel(parsed, file.name);
          afterLoad(parsed.properties?.name ?? 'Model');
        }
      } catch (err) {
        showToast(`Could not open file: ${err instanceof Error ? err.message : 'invalid project file'}`);
      } finally {
        busyHandle.end();
      }
    });
  }, []);

  return (
    <div className={styles.app} onContextMenu={e => e.preventDefault()}>
      <nav className={styles.navbar}>
        {/* Left: brand + file/help actions + model name */}
        <div className={styles.navLeft}>
          <img
            className={styles.logo}
            src={`${import.meta.env.BASE_URL}icon.svg`}
            alt=""
            width={22}
            height={22}
            draggable={false}
          />
          <span className={styles.title}>GenesisCA <span className={styles.version}>v1.32.0</span></span>
          <FileMenu onNew={() => setMode('modeler')} onLoaded={afterLoad} />
          <button
            className={`${styles.navButton} ${mode === 'library' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('library')}
          >Library</button>
          <span className={styles.modelName}>
            {model.properties.name}
            {loadedFileName && <span className={styles.fileName}> ({loadedFileName})</span>}
            {isDirty && <span className={styles.dirtyIndicator}> *</span>}
          </span>
        </div>

        {/* Center: application modes (Blender-style), centered in the free space */}
        <div className={styles.navCenter}>
          <button
            className={`${styles.navButton} ${styles.navModeButton} ${mode === 'modeler' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('modeler')}
          >{MODELER_ICON}Modeler</button>
          <button
            className={`${styles.navButton} ${styles.navModeButton} ${mode === 'simulator' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('simulator')}
          >{SIMULATOR_ICON}Simulator</button>
        </div>

        {/* Right: app-level controls */}
        <div className={styles.navRight}>
          {import.meta.env.DEV && (
            <button
              className={`${styles.navButton} ${mode === 'styleref' ? styles.navButtonActive : ''}`}
              onClick={() => setMode('styleref')}
            >Style Reference</button>
          )}
          <button
            className={`${styles.navButton} ${mode === 'help' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('help')}
          >Help</button>
          <button
            style={navIconBtn}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            onClick={() => setShortcutsOpen(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="6.5" width="20" height="11" rx="2" />
              <path d="M6 10.5h0M10 10.5h0M14 10.5h0M18 10.5h0M8 14h8" />
            </svg>
          </button>
          <ThemeSwitcher />
          <InstallButton />
          <a
            className={styles.githubLink}
            href="https://github.com/rff255/GenesisCA"
            target="_blank"
            rel="noopener noreferrer"
            title="View on GitHub"
          >
            <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52
                -.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2
                -3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82
                .64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08
                2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01
                1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
        </div>
      </nav>
      <main className={styles.content}>
        {mode === 'modeler' && <ModelerView />}
        <div style={{ display: mode === 'simulator' ? 'contents' : 'none' }}>
          <SimulatorView visible={mode === 'simulator'} />
        </div>
        {mode === 'help' && <HelpView />}
        {mode === 'library' && <ModelsLibrary onLoadModel={handleLoadLibraryModel} />}
        {mode === 'styleref' && <StyleReferenceView />}
      </main>
      {pendingLibLoad && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="You have unsaved changes that will be lost if you load this library model."
          confirmLabel="Load"
          danger
          onConfirm={() => {
            const p = pendingLibLoad;
            setPendingLibLoad(null);
            loadModel(p.model, p.fileName);
            afterLoad(p.model.properties.name);
          }}
          onCancel={() => setPendingLibLoad(null)}
        />
      )}
      {pendingStateDrop && (
        <ConfirmDialog
          title="Replace the simulation state?"
          message={`Load "${pendingStateDrop.name}" and replace the current grid/agent state? The model definition is untouched.`}
          confirmLabel="Replace"
          danger
          onConfirm={() => {
            const f = pendingStateDrop;
            setPendingStateDrop(null);
            setMode('simulator');
            window.dispatchEvent(new CustomEvent('genesis-load-state-file', { detail: { file: f } }));
          }}
          onCancel={() => setPendingStateDrop(null)}
        />
      )}
      {dragActive && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.45)', border: '3px dashed var(--color-accent)',
          color: 'var(--color-text-primary)', fontSize: '1.05rem', fontWeight: 600,
        }}>
          Drop to open — .gcaproj / .gcastate / .gcapreset / .gcamacro / .csv / .asc / .tif / .geojson / image
        </div>
      )}
      <BusyOverlay />
      {toast && (
        <div className={`${styles.toast}${busy ? ` ${styles.loweredForBusy}` : ''}`}>{toast}</div>
      )}
      {updateReady && (
        <div className={`${styles.updateBanner}${busy ? ` ${styles.loweredForBusy}` : ''}`} role="status">
          <span className={styles.updateText}>
            A new version of GenesisCA is available.
            {isDirty && ' Updating reloads the app — save your model first, unsaved changes will be lost.'}
          </span>
          <button
            className={styles.updateBtn}
            onClick={() => { setUpdateReady(false); void updateSWRef.current?.(true); }}
          >
            Update
          </button>
          <button className={styles.updateLater} onClick={() => setUpdateReady(false)}>
            Later
          </button>
        </div>
      )}
      <KeyboardShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

export function App() {
  return (
    <ModelProvider>
      <AppInner />
    </ModelProvider>
  );
}

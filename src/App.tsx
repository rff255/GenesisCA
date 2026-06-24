import { useEffect, useRef, useState } from 'react';
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
import type { CAModel } from './model/types';
import styles from './App.module.css';

type AppMode = 'modeler' | 'simulator' | 'help' | 'library' | 'styleref';

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
  // Transient load-confirmation toast (auto-dismisses).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (msg: string) => {
    if (toastTimer.current != null) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };
  useEffect(() => () => { if (toastTimer.current != null) clearTimeout(toastTimer.current); }, []);

  // Register the offline service worker + request durable storage. The SW
  // auto-updates silently (registerType 'autoUpdate' in vite.config) — no
  // "update available" prompt (there's no in-app update channel, and the app
  // does no online processing) and no "offline ready" toast (it ALWAYS works
  // offline, so announcing it is noise).
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
      registerSW({ immediate: true });
      // Auto-granted once installed; keeps the offline cache from being evicted
      // under disk pressure. Storage durability only — does NOT raise the memory
      // ceiling for large grids; neither does the current Tauri shell (same
      // Chromium/WebView2 engine) — only a native-Rust simulation would.
      navigator.storage?.persist?.().catch(() => {});
    }
    // Fade out + remove the static boot splash (index.html) now that React has
    // mounted and the app shell is on screen.
    const splash = document.getElementById('splash');
    if (splash) {
      splash.classList.add('splash-hide');
      const t = window.setTimeout(() => splash.remove(), 400);
      return () => clearTimeout(t);
    }
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
          <span className={styles.title}>GenesisCA <span className={styles.version}>v1.22.0</span></span>
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
            className={`${styles.navButton} ${mode === 'modeler' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('modeler')}
          >Modeler</button>
          <button
            className={`${styles.navButton} ${mode === 'simulator' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('simulator')}
          >Simulator</button>
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
      {toast && <div className={styles.toast}>{toast}</div>}
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

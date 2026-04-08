import { useState } from 'react';
import { ModelProvider, useModel } from './model/ModelContext';
import { FileMenu } from './components/FileMenu';
import { ModelerView } from './modeler/ModelerView';
import { SimulatorView } from './simulator/SimulatorView';
import { HelpView } from './help/HelpView';
import { ModelsLibrary } from './library/ModelsLibrary';
import styles from './App.module.css';

type AppMode = 'modeler' | 'simulator' | 'help' | 'library';

function AppInner() {
  const [mode, setMode] = useState<AppMode>('modeler');
  const { model, isDirty, loadModel } = useModel();

  const handleLoadLibraryModel = (model: Parameters<typeof loadModel>[0]) => {
    if (isDirty && !window.confirm('You have unsaved changes. Load a library model?')) return;
    loadModel(model);
    setMode('modeler');
  };

  return (
    <div className={styles.app}>
      <nav className={styles.navbar}>
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
        <span className={styles.title}>GenesisCA <span className={styles.version}>v1.1.0</span></span>
        <div className={styles.navTabs}>
          <button
            className={`${styles.navButton} ${mode === 'modeler' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('modeler')}
          >
            Modeler
          </button>
          <button
            className={`${styles.navButton} ${mode === 'simulator' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('simulator')}
          >
            Simulator
          </button>
          <button
            className={`${styles.navButton} ${mode === 'help' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('help')}
          >
            Help
          </button>
          <button
            className={`${styles.navButton} ${mode === 'library' ? styles.navButtonActive : ''}`}
            onClick={() => setMode('library')}
          >
            Library
          </button>
        </div>
        <span className={styles.modelName}>
          {model.properties.name}{isDirty && <span className={styles.dirtyIndicator}> *</span>}
        </span>
        <FileMenu />
      </nav>
      <main className={styles.content}>
        {mode === 'modeler' && <ModelerView />}
        {mode === 'simulator' && <SimulatorView />}
        {mode === 'help' && <HelpView />}
        {mode === 'library' && <ModelsLibrary onLoadModel={handleLoadLibraryModel} />}
      </main>
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

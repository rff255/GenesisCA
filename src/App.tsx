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
  const { isDirty, loadModel } = useModel();

  const handleLoadLibraryModel = (model: Parameters<typeof loadModel>[0]) => {
    if (isDirty && !window.confirm('You have unsaved changes. Load a library model?')) return;
    loadModel(model);
    setMode('modeler');
  };

  return (
    <div className={styles.app}>
      <nav className={styles.navbar}>
        <span className={styles.title}>GenesisCA <span className={styles.version}>v1.0.0</span></span>
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

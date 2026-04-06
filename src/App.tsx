import { useState } from 'react';
import { ModelerView } from './modeler/ModelerView';
import { SimulatorView } from './simulator/SimulatorView';
import styles from './App.module.css';

type AppMode = 'modeler' | 'simulator';

export function App() {
  const [mode, setMode] = useState<AppMode>('modeler');

  return (
    <div className={styles.app}>
      <nav className={styles.navbar}>
        <span className={styles.title}>GenesisCA</span>
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
        </div>
      </nav>
      <main className={styles.content}>
        {mode === 'modeler' ? <ModelerView /> : <SimulatorView />}
      </main>
    </div>
  );
}

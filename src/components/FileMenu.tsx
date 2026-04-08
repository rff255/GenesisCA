import { useRef } from 'react';
import { useModel } from '../model/ModelContext';
import {
  serializeModel,
  modelFilename,
  downloadJSON,
  readModelFile,
} from '../model/fileOperations';
import styles from './FileMenu.module.css';

export function FileMenu() {
  const { model, isDirty, newModel, loadModel, markSaved } = useModel();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleNew = () => {
    if (isDirty && !window.confirm('You have unsaved changes. Create a new model?')) {
      return;
    }
    newModel();
  };

  const handleSave = () => {
    const json = serializeModel(model);
    const filename = modelFilename(model);
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
    // Reset so the same file can be re-selected
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
      {/* Dirty indicator moved to model name in navbar */}
    </div>
  );
}

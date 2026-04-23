import { useEffect, useState } from 'react';
import type { CAModel } from '../model/types';
import styles from './ModelsLibrary.module.css';

interface LibraryEntry {
  id: string;
  name: string;
  author: string;
  modelAuthor?: string;
  description: string;
  file: string;
  tags: string[];
  gridSize: string;
}

interface Props {
  onLoadModel: (model: CAModel) => void;
}

export function ModelsLibrary({ onLoadModel }: Props) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const base = import.meta.env.BASE_URL ?? '/';
    fetch(`${base}models/index.json`)
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load library index (${r.status})`);
        return r.json();
      })
      .then((data: LibraryEntry[]) => {
        setEntries(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load library.');
        setLoading(false);
      });
  }, []);

  const handleClick = async (entry: LibraryEntry) => {
    try {
      const base = import.meta.env.BASE_URL ?? '/';
      const r = await fetch(`${base}models/${entry.file}`);
      if (!r.ok) throw new Error(`Failed to load model (${r.status})`);
      const model = (await r.json()) as CAModel;
      onLoadModel(model);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load model.');
    }
  };

  return (
    <div className={styles.layout}>
      <h1 className={styles.title}>Models Library</h1>
      <p className={styles.subtitle}>
        Explore pre-made cellular automata models. Click one to load it in the Modeler.
      </p>

      {loading && <p className={styles.loading}>Loading library...</p>}
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.grid}>
        {entries.map(entry => (
          <div
            key={entry.id}
            className={styles.card}
            onClick={() => handleClick(entry)}
          >
            <div className={styles.cardName}>{entry.name}</div>
            {entry.author && (
              <div className={styles.cardAuthor}>Rule by: {entry.author}</div>
            )}
            {entry.modelAuthor && (
              <div className={styles.cardAuthor}>Project by: {entry.modelAuthor}</div>
            )}
            <div className={styles.cardDesc}>{entry.description}</div>
            <div className={styles.cardMeta}>
              {entry.tags.map(tag => (
                <span key={tag} className={styles.tag}>{tag}</span>
              ))}
              <span className={styles.gridSize}>{entry.gridSize}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

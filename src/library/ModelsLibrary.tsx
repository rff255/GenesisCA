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
  /** Sidecar filename (e.g. `"Game Of Life.gcaproj.thumb.gif"`) emitted by the
   *  Vite plugin. Absent when the source .gcaproj has no embedded thumbnail. */
  thumbnail?: string;
}

interface Props {
  onLoadModel: (model: CAModel) => void;
}

const POPOVER_SIZE = 320;
const POPOVER_GAP = 8;

interface HoverState {
  thumbnail: string;
  top: number;
  left: number;
}

function computePopoverPosition(rect: DOMRect): { top: number; left: number } {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  // Centre the popover on the card. The popover has `pointer-events: none`
  // (see ModelsLibrary.module.css) so it doesn't steal the card's hover —
  // the user's cursor stays "on" the card even when the popover overlays it.
  let left = rect.left + rect.width / 2 - POPOVER_SIZE / 2;
  let top = rect.top + rect.height / 2 - POPOVER_SIZE / 2;
  // Clamp to viewport so corner cards still get a fully-visible popover.
  left = Math.max(POPOVER_GAP, Math.min(viewportW - POPOVER_SIZE - POPOVER_GAP, left));
  top = Math.max(POPOVER_GAP, Math.min(viewportH - POPOVER_SIZE - POPOVER_GAP, top));
  return { top, left };
}

export function ModelsLibrary({ onLoadModel }: Props) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);

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

  const handleCardEnter = (entry: LibraryEntry, el: HTMLElement) => {
    if (!entry.thumbnail) return;
    const base = import.meta.env.BASE_URL ?? '/';
    const rect = el.getBoundingClientRect();
    setHover({
      thumbnail: `${base}models/${entry.thumbnail}`,
      ...computePopoverPosition(rect),
    });
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
            onMouseEnter={e => handleCardEnter(entry, e.currentTarget)}
            onMouseLeave={() => setHover(null)}
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

      {hover && (
        <div
          className={styles.thumbnailPopover}
          style={{ top: hover.top, left: hover.left }}
        >
          <img src={hover.thumbnail} alt="" className={styles.thumbnailImg} />
        </div>
      )}
    </div>
  );
}

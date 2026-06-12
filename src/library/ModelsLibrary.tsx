import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  onLoadModel: (model: CAModel, fileName?: string) => void;
}

// The popover width is fixed in CSS; its height is content-driven and measured
// after render (see the useLayoutEffect below) so it can be positioned exactly.
const POPOVER_WIDTH = 320;
const POPOVER_GAP = 8;

interface CardRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface HoverState {
  thumbnail?: string;
  description: string;
  cardRect: CardRect;
}

function computePopoverPosition(
  card: CardRect,
  popoverHeight: number,
): { top: number; left: number } {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  // Centred over the card — it overlays the card rather than sitting beside it.
  // `pointer-events: none` (see the CSS module) keeps the card's hover intact,
  // so the cursor stays "on" the card even while the popover covers it.
  let left = (card.left + card.right) / 2 - POPOVER_WIDTH / 2;
  let top = (card.top + card.bottom) / 2 - popoverHeight / 2;
  // Clamp so corner cards still get a fully-visible popover.
  left = Math.max(POPOVER_GAP, Math.min(viewportW - POPOVER_WIDTH - POPOVER_GAP, left));
  top = Math.max(POPOVER_GAP, Math.min(viewportH - popoverHeight - POPOVER_GAP, top));
  return { top, left };
}

export function ModelsLibrary({ onLoadModel }: Props) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // The popover is rendered first (invisible), measured, then positioned — the
  // only way to place a content-sized box exactly without guessing its height.
  // useLayoutEffect runs before paint, so the unpositioned frame is never shown.
  useLayoutEffect(() => {
    if (!hover || !popoverRef.current) return;
    setPopoverPos(computePopoverPosition(hover.cardRect, popoverRef.current.offsetHeight));
  }, [hover]);

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
      onLoadModel(model, entry.file);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load model.');
    }
  };

  const handleCardEnter = (entry: LibraryEntry, el: HTMLElement) => {
    if (!entry.thumbnail && !entry.description.trim()) return;
    const base = import.meta.env.BASE_URL ?? '/';
    const r = el.getBoundingClientRect();
    setPopoverPos(null); // hidden until useLayoutEffect measures + positions it
    setHover({
      thumbnail: entry.thumbnail ? `${base}models/${entry.thumbnail}` : undefined,
      description: entry.description,
      cardRect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
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
          ref={popoverRef}
          className={styles.previewPopover}
          style={
            popoverPos
              ? { top: popoverPos.top, left: popoverPos.left }
              : { visibility: 'hidden' }
          }
        >
          {hover.thumbnail && (
            <img src={hover.thumbnail} alt="" className={styles.previewThumb} />
          )}
          {hover.description && (
            <p className={styles.previewDesc}>{hover.description}</p>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { MODEL_ARCHETYPES, type ArchetypeId } from '../model/archetypes';
import dlg from './SaveProjectDialog.module.css';
import styles from './NewModelDialog.module.css';

/** C7 (P6) — the archetype chooser behind `File ▾ → New`.
 *
 *  A card is a SEED, not a wizard: picking one dispatches ONE `NEW_MODEL`
 *  carrying a fully-formed model, and every field it set stays editable in the
 *  panel it belongs to. `Empty` reproduces today's New exactly.
 *
 *  Opened AFTER the unsaved-changes confirmation (FileMenu), so the destructive
 *  confirmation still guards the destructive act — and cancelling here keeps the
 *  current model even though the confirm was already accepted. */
export function NewModelDialog({ onCreate, onCancel }: {
  onCreate: (id: ArchetypeId) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<ArchetypeId>('ca2d');
  const gridRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Focus the initially-selected card so arrow keys + Enter work immediately.
  useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]')?.focus();
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key === 'Enter') { e.preventDefault(); onCreate(selectedRef.current); return; }
      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1
        : e.key === 'ArrowDown' ? 4 : e.key === 'ArrowUp' ? -4 : 0;
      if (!delta) return;
      e.preventDefault();
      const i = MODEL_ARCHETYPES.findIndex(a => a.id === selectedRef.current);
      const next = MODEL_ARCHETYPES[Math.min(MODEL_ARCHETYPES.length - 1, Math.max(0, i + delta))];
      if (next) {
        setSelected(next.id);
        gridRef.current?.querySelector<HTMLButtonElement>(`[data-archetype="${next.id}"]`)?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCreate, onCancel]);

  return (
    <div className={dlg.backdrop} onClick={onCancel} data-testid="new-model-dialog">
      <div className={`${dlg.dialog} ${styles.wide}`} onClick={e => e.stopPropagation()}>
        <div className={dlg.title}>
          New model
          <div style={{ fontWeight: 400, fontSize: 'var(--font-xs)', color: 'var(--color-text-tertiary)', marginTop: 2 }}>
            Pick a starting point. Everything a card sets is editable afterwards — these are seeds, not a wizard.
          </div>
        </div>
        <div className={dlg.body}>
          <div className={styles.grid} ref={gridRef}>
            {MODEL_ARCHETYPES.map(a => (
              <button
                key={a.id}
                type="button"
                data-archetype={a.id}
                data-selected={a.id === selected}
                className={`${styles.card} ${a.id === selected ? styles.selected : ''}`}
                onClick={() => setSelected(a.id)}
                onDoubleClick={() => onCreate(a.id)}
                aria-pressed={a.id === selected}
              >
                <ArchetypeIcon id={a.id} />
                <span className={styles.name}>{a.label}</span>
                <span className={styles.desc}>{a.description}</span>
                <span className={styles.tags}>
                  {a.tags.map(t => <span key={t} className={styles.tag}>{t}</span>)}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className={dlg.actions}>
          <button className={dlg.btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={dlg.btnPrimary} onClick={() => onCreate(selected)}>Create</button>
        </div>
      </div>
    </div>
  );
}

/** Tiny inline schematics — no assets, theme-agnostic (currentColor-free so the
 *  accent reads the same on the selected card as on the rest). */
function ArchetypeIcon({ id }: { id: ArchetypeId }) {
  const A = 'var(--color-accent)';
  const c = { width: 46, height: 28, viewBox: '0 0 46 28', className: styles.icon, 'aria-hidden': true } as const;
  switch (id) {
    case 'ca2d': return (
      <svg {...c}>
        <g fill="none" stroke={A} strokeWidth="1" opacity=".45">
          <rect x="9" y="3" width="28" height="22" />
          <path d="M16 3v22M23 3v22M30 3v22M9 10h28M9 17h28" opacity=".6" />
        </g>
        <rect x="16" y="10" width="7" height="7" fill={A} opacity=".85" />
        <rect x="23" y="17" width="7" height="7" fill={A} opacity=".5" />
      </svg>
    );
    case 'ca3d': return (
      <svg {...c}>
        <g fill="none" stroke={A} strokeWidth="1" opacity=".5">
          <path d="M13 8h18v14H13zM19 4h18v14H19M13 8l6-4M31 8l6-4M31 22l6-4" />
        </g>
        <rect x="18" y="11" width="6" height="6" fill={A} opacity=".8" />
        <rect x="24" y="8" width="6" height="6" fill={A} opacity=".45" />
      </svg>
    );
    case 'particles': return (
      <svg {...c}>
        <g fill={A} opacity=".85">
          <circle cx="12" cy="8" r="2.6" /><circle cx="22" cy="5" r="2.6" /><circle cx="33" cy="10" r="2.6" />
          <circle cx="16" cy="18" r="2.6" /><circle cx="27" cy="20" r="2.6" /><circle cx="36" cy="21" r="2.6" />
        </g>
      </svg>
    );
    case 'flocking': return (
      <svg {...c}>
        <g fill={A} opacity=".9">
          <path d="M10 13l7-3-1 3 1 3z" /><path d="M20 8l7-3-1 3 1 3z" />
          <path d="M21 20l7-3-1 3 1 3z" /><path d="M31 14l7-3-1 3 1 3z" />
        </g>
      </svg>
    );
    case 'tissue': return (
      <svg {...c}>
        <path d="M17 9l6-4 7 5-3 8-8 1z" fill="none" stroke={A} strokeWidth=".9" opacity=".45" />
        <g fill={A} opacity=".8">
          <circle cx="17" cy="9" r="3.4" /><circle cx="23" cy="5" r="3.4" />
          <circle cx="30" cy="10" r="3.4" /><circle cx="27" cy="18" r="3.4" /><circle cx="19" cy="19" r="3.4" />
        </g>
      </svg>
    );
    case 'gra': return (
      <svg {...c}>
        <g stroke={A} strokeWidth=".9" opacity=".55" fill="none">
          <path d="M13 7l9 3 9-4M22 10l-4 10 12 1M31 6l-1 15M13 7l5 13" />
        </g>
        <g fill={A} opacity=".9">
          <circle cx="13" cy="7" r="2.4" /><circle cx="22" cy="10" r="2.4" /><circle cx="31" cy="6" r="2.4" />
          <circle cx="18" cy="20" r="2.4" /><circle cx="30" cy="21" r="2.4" />
        </g>
      </svg>
    );
    case 'caOnAgents': return (
      <svg {...c}>
        <g fill={A} opacity=".7">
          <circle cx="14" cy="7" r="2.2" /><circle cx="22" cy="7" r="2.2" /><circle cx="30" cy="7" r="2.2" />
          <circle cx="14" cy="14" r="2.2" /><circle cx="30" cy="14" r="2.2" />
          <circle cx="14" cy="21" r="2.2" /><circle cx="22" cy="21" r="2.2" /><circle cx="30" cy="21" r="2.2" />
        </g>
        <circle cx="22" cy="14" r="2.6" fill={A} />
      </svg>
    );
    case 'empty': default: return (
      <svg {...c}>
        <rect x="10" y="4" width="26" height="20" fill="none" stroke="var(--color-text-tertiary)"
          strokeWidth="1" strokeDasharray="3 3" opacity=".6" />
      </svg>
    );
  }
}

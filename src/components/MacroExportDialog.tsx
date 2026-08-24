import { useEffect, useMemo, useState } from 'react';
import styles from './MacroExportDialog.module.css';
import type {
  CollectedReference, CollectedReferences, ElementSpace,
} from '../model/macroReferences';
import { SPACE_LABEL, SPACE_ORDER, defaultSelection, pruneOrphanSelection } from '../model/macroReferences';
import type { Attribute, FaceLabelPalette, FacePattern, Indicator, Mapping, Neighborhood, SpriteAsset, Variable } from '../model/types';
import { typeDisplayName } from '../model/typeLabels';

interface Props {
  macroName: string;
  collected: CollectedReferences;
  /** `selected` holds the ids to embed; everything else is left to dangle on
   *  import (which is exactly today's behaviour). */
  onExport: (selected: Set<string>) => void;
  onCancel: () => void;
}

/** One-line description of an element, read off the object itself — the bundle
 *  carries elements VERBATIM, so there is no parallel metadata record to drift. */
export function describeElement(ref: CollectedReference): string {
  const el = ref.element;
  if (!el) return 'not found in this model';
  switch (ref.space) {
    case 'attributes':
    case 'agentAttributes':
    case 'bondAttributes': {
      const a = el as Attribute;
      const kind = typeDisplayName(a.type);
      const opts = a.type === 'tag' && a.tagOptions?.length ? ` (${a.tagOptions.length} options)` : '';
      const scope = a.isModelAttribute ? 'model · ' : '';
      return `${scope}${kind}${opts}`;
    }
    case 'neighborhoods': {
      const n = el as Neighborhood;
      const count = (n.coords3d?.length ?? n.coords?.length ?? 0);
      const tags = Object.keys(n.tags ?? {}).length;
      return `${count} cells${tags ? `, ${tags} tagged` : ''}`;
    }
    case 'mappings':
    case 'agentMappings': {
      const m = el as Mapping;
      if (!m.isAttributeToColor) return `Color → Attribute${m.parameters ? `, ${m.parameters.length} parameters` : ''}`;
      return `Attribute → Color${m.linked ? ', linked' : ''}`;
    }
    case 'variables':
    case 'agentVariables': {
      const v = el as Variable;
      const len = v.kind === 'array' ? ` (${v.length ?? 0})` : '';
      return `${v.kind}${len} · ${typeDisplayName(v.dataType)}`;
    }
    case 'indicators': {
      const i = el as Indicator;
      return `${i.kind} · ${typeDisplayName(i.dataType)}`;
    }
    case 'sprites': {
      const s = el as SpriteAsset;
      const frames = s.frames?.length ? `, ${s.frames.length} frames` : '';
      return `${(s.mimeType || 'image').replace('image/', '')}${frames}`;
    }
    case 'facePalettes':
      return `${(el as FaceLabelPalette).labels?.length ?? 0} labels`;
    case 'facePatterns':
      return (el as FacePattern).layoutMode ?? 'face pattern';
    case 'presets':
      return 'preset';
    default:
      return '';
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** Show a size only where it can plausibly matter — a sprite is the one element
 *  that can be megabytes, which is what the per-element opt-out is for. */
const SIZE_THRESHOLD = 20_000;

/**
 * Export Macro — the per-element opt-out.
 *
 * Embedding is the DEFAULT: the decision that matters (import as new / remap /
 * discard) belongs on the import side, where the target model exists. This
 * dialog is here for the one element that can be megabytes — a sprite — and for
 * the deliberate "reference-free template" case.
 *
 * Unchecking an element leaves its reference dangling on import, which is
 * precisely today's behaviour.
 */
export function MacroExportDialog({ macroName, collected, onExport, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(collected));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const groups = useMemo(() => {
    const carryable = new Map<ElementSpace, CollectedReference[]>();
    const blocked: CollectedReference[] = [];
    for (const ref of collected.refs) {
      if (!ref.carryable || !ref.space) { blocked.push(ref); continue; }
      const list = carryable.get(ref.space) ?? [];
      list.push(ref);
      carryable.set(ref.space, list);
    }
    return { carryable, blocked };
  }, [collected]);

  const carryableCount = collected.refs.filter(r => r.carryable).length;

  const toggle = (ref: CollectedReference, on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (on) {
        // Re-check what this element NEEDS too, or the bundle would carry an
        // attribute whose sub-attribute parent (or tag axis) is missing.
        const queue = [ref.id];
        while (queue.length > 0) {
          const id = queue.shift()!;
          if (next.has(id)) continue;
          next.add(id);
          for (const r of collected.refs) {
            if (r.carryable && r.requiredBy.includes(id) && !next.has(r.id)) queue.push(r.id);
          }
        }
        return next;
      }
      next.delete(ref.id);
      // Whatever existed only because this element needed it goes with it.
      return pruneOrphanSelection(collected, next);
    });
  };

  const renderRow = (ref: CollectedReference) => {
    const closureOnly = ref.directCount === 0 && ref.requiredBy.length > 0;
    const requirerId = ref.requiredBy[0];
    const requirer = closureOnly && requirerId ? collected.byId.get(requirerId) : undefined;
    const on = selected.has(ref.id);
    const showSize = ref.bytes >= SIZE_THRESHOLD;
    return (
      <label key={ref.id} className={`${styles.row} ${closureOnly ? styles.indent : ''}`}>
        <input type="checkbox" checked={on} onChange={e => toggle(ref, e.target.checked)} />
        <div className={styles.rowMain}>
          <div>
            <span className={styles.name}>{ref.name}</span>
            <span className={styles.kind}> · {describeElement(ref)}</span>
          </div>
          {closureOnly && requirer && (
            <div className={styles.meta}>
              pulled in by <i>{requirer.name}</i> → {ref.requiredVia[0]}
            </div>
          )}
          {showSize && (
            <div className={`${styles.meta} ${on ? '' : styles.warn}`}>
              {formatSize(ref.bytes)}{on ? '' : ' — unchecked, so this reference will dangle on import'}
            </div>
          )}
          {!showSize && !on && (
            <div className={`${styles.meta} ${styles.warn}`}>unchecked — this reference will dangle on import</div>
          )}
        </div>
        <div className={styles.origin}>
          {ref.directCount > 0 ? `referenced by ${ref.directCount} node${ref.directCount === 1 ? '' : 's'}` : 'closure'}
        </div>
      </label>
    );
  };

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.title}>Export Macro — “{macroName}”</div>
          <div className={styles.subtitle}>
            {carryableCount} referenced definition{carryableCount === 1 ? '' : 's'} found · uncheck to leave a
            reference dangling on import
          </div>
        </div>

        <div className={styles.body}>
          {SPACE_ORDER.map(space => {
            const list = groups.carryable.get(space);
            if (!list || list.length === 0) return null;
            return (
              <div key={space}>
                <div className={styles.section}>{SPACE_LABEL[space]}</div>
                {list.map(renderRow)}
              </div>
            );
          })}

          {groups.blocked.length > 0 && (
            <div>
              <div className={styles.section}>Cannot be carried</div>
              {groups.blocked.map(ref => (
                <div key={ref.id} className={`${styles.row} ${styles.blocked}`}>
                  <div className={styles.rowMain}>
                    <div>
                      <span className={styles.name} style={{ color: 'var(--color-text-tertiary)' }}>{ref.name}</span>
                      <span className={styles.kind}> · {describeElement(ref)}</span>
                    </div>
                    <div className={styles.meta}>{ref.blockedReason} — this reference will dangle</div>
                  </div>
                  <div className={styles.origin}>
                    {ref.directFrom[0] ?? 'closure'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setSelected(prev => (prev.size === 0 ? defaultSelection(collected) : new Set()))}
          >
            {selected.size === 0 ? 'Embed all references' : 'Reference-free template'}
          </button>
          <div className={styles.btnRow}>
            <button type="button" className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
            <button type="button" className={styles.btnPrimary} onClick={() => onExport(selected)}>Export</button>
          </div>
        </div>
      </div>
    </div>
  );
}

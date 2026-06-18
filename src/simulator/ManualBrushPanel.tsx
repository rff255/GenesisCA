import { useMemo } from 'react';
import type { Attribute, Neighborhood } from '../model/types';
import { subAttrInfo } from '../modeler/vpl/compiler/subAttribute';
import { InlineBoolSelect, InlineNumberInput, InlineTagSelect } from '../modeler/vpl/widgets/InlineWidgets';
import { NeighborIndexValuePicker } from '../modeler/panels/NeighborIndexDefaultEditor';
import styles from './SimulatorView.module.css';
import type { ManualBrushModelState } from './SimulatorView';

interface ManualBrushPanelProps {
  cellAttributes: Attribute[];
  /** For resolving neighborIndex attrs' hint neighborhood (grid picker). */
  neighborhoods: Neighborhood[];
  state: ManualBrushModelState;
  onChange: (next: ManualBrushModelState) => void;
  /** 3D Grid CA: neighborIndex attrs pack 3 axes — the picker adds a dl stepper. */
  is3d?: boolean;
}

/** Format a parentValues entry for the sub-attribute hint. Tag parents map
 *  the stored integer-index strings back to their tagOption labels; bool
 *  parents display "true"/"false" literally. */
function formatParentValue(parent: Attribute, raw: string): string {
  if (parent.type === 'tag') {
    const idx = parseInt(raw, 10);
    if (Number.isFinite(idx)) {
      const opt = parent.tagOptions?.[idx];
      if (opt) return opt;
    }
    return raw;
  }
  if (parent.type === 'bool') return raw === 'true' || raw === '1' ? 'true' : 'false';
  return raw;
}

/** Renders one row per cell attribute: [Set checkbox] [name + sub-attr hint] [value widget].
 *  Sub-attribute hint reads as e.g. "writes only when cellType ∈ {Wire, Pulsar}". */
export function ManualBrushPanel({ cellAttributes, neighborhoods, state, onChange, is3d = false }: ManualBrushPanelProps) {
  const model = useMemo(() => ({ attributes: cellAttributes }), [cellAttributes]);
  const setEntry = (attrId: string, patch: Partial<{ enabled: boolean; value: string }>): void => {
    const prev = state[attrId] ?? { enabled: true, value: '' };
    onChange({ ...state, [attrId]: { ...prev, ...patch } });
  };

  if (cellAttributes.length === 0) {
    return <div className={styles.manualBrushEmpty}>No cell attributes to paint.</div>;
  }

  return (
    <div className={styles.manualBrushPanel}>
      {cellAttributes.map(attr => {
        const entry = state[attr.id] ?? { enabled: true, value: attr.defaultValue ?? '' };
        const info = subAttrInfo(attr, model);
        const widgetClass = `${styles.manualBrushWidget} ${entry.enabled ? '' : styles.dim}`;
        return (
          <div key={attr.id} className={styles.manualBrushRow}>
            <input
              type="checkbox"
              className={styles.manualBrushCheckbox}
              checked={entry.enabled}
              onChange={e => setEntry(attr.id, { enabled: e.target.checked })}
              title={entry.enabled ? `Uncheck to skip writing ${attr.name}` : `Check to write ${attr.name}`}
            />
            <div className={styles.manualBrushLabel}>
              <div className={styles.manualBrushName} title={attr.description || undefined}>{attr.name}</div>
              {info && (
                <div className={styles.manualBrushHint}>
                  writes only when {info.parent.name} ∈ {'{'}
                  {info.parentValues.map(v => formatParentValue(info.parent, v)).join(', ')}
                  {'}'}
                </div>
              )}
            </div>
            <div className={widgetClass}>
              {attr.type === 'bool' && (
                <InlineBoolSelect
                  value={entry.value || 'false'}
                  onChange={v => setEntry(attr.id, { value: v })}
                />
              )}
              {(attr.type === 'integer' || attr.type === 'float') && (
                <InlineNumberInput
                  value={entry.value ?? ''}
                  onChange={v => setEntry(attr.id, { value: v })}
                  step={attr.type === 'float' ? 'any' : 1}
                />
              )}
              {attr.type === 'neighborIndex' && (
                <NeighborIndexValuePicker
                  value={(() => { const n = parseInt(entry.value ?? '', 10); return Number.isFinite(n) ? n : 0; })()}
                  hint={attr.neighborhoodHintId
                    ? (neighborhoods.find(n => n.id === attr.neighborhoodHintId) ?? null)
                    : null}
                  is3d={is3d}
                  onChange={packed => setEntry(attr.id, { value: String(packed) })}
                  cellSize={16}
                />
              )}
              {attr.type === 'tag' && (
                <InlineTagSelect
                  value={entry.value || '0'}
                  options={attr.tagOptions ?? []}
                  onChange={v => setEntry(attr.id, { value: v })}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

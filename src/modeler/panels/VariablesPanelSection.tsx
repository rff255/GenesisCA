import { useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import type { VariableDataType, VariableKind } from '../../model/types';
import { useListReorder } from './useListReorder';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import styles from './PanelContent.module.css';

/** Properties-panel section for Local Variables — per-cell scratch storage
 *  referenced by getVariable / setVariable / setArrayElement nodes. Mirrors
 *  the Indicators section's interaction shape (list + inspector for selected
 *  item, +Variable button, drag-to-reorder). */
export function VariablesPanelSection({ mode = 'list' }: PanelContentProps = {}) {
  const { model, addVariable, removeVariable, updateVariable, reorderVariables } = useModel();
  const variables = model.variables || [];
  const [selectedId, setSelectedId] = useDetailSelection('variables');
  const reorder = useListReorder(variables, reorderVariables);

  const prevCount = useRef(variables.length);
  useEffect(() => {
    if (variables.length > prevCount.current) {
      const newItem = variables[variables.length - 1];
      if (newItem) {
        setSelectedId(newItem.id);
        setTimeout(() => {
          document.getElementById(`var-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevCount.current = variables.length;
  }, [variables]);
  const selected = variables.find(v => v.id === selectedId);

  // Tag-type variables borrow a tag attribute's tag space. Both cell and
  // model tag attrs are valid sources.
  const tagAttrs = model.attributes.filter(a => a.type === 'tag');
  const selTagAttr = selected?.attributeId
    ? model.attributes.find(a => a.id === selected.attributeId)
    : undefined;

  return (
    <>
      {mode !== 'detail' && (
      <div className={styles.section}>
      <div className={styles.sectionTitle}>Local Variables</div>
      <div className={styles.sectionHelp}>
        Per-cell scratch storage referenced by Get / Set Variable nodes. Each
        cell sees a fresh copy initialised to the variable's Initial Value at
        the start of every step — not persisted between steps or shared across
        cells.
      </div>

      <div className={styles.list} data-reorder-list>
        {variables.map((v, i) => {
          const isDragging = reorder.dragState?.id === v.id;
          const srcIdx = reorder.dragState ? variables.findIndex(x => x.id === reorder.dragState!.id) : -1;
          const showBefore = reorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
          const showAfter = reorder.dragState?.overIdx === variables.length && i === variables.length - 1 && srcIdx !== i;
          return (
            <div
              key={v.id}
              id={`var-${v.id}`}
              data-reorder-row
              className={`${styles.listItem} ${v.id === selectedId ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
              onClick={() => setSelectedId(v.id === selectedId ? null : v.id)}
            >
              <span className={styles.listItemName}>{v.name}</span>
              <span className={styles.listItemBadge}>
                {v.kind === 'array' ? `${v.dataType}[${v.length ?? '?'}]` : v.dataType}
              </span>
              <button className={styles.dragHandle} title="Drag to reorder"
                onPointerDown={reorder.startDrag(v.id)}
                onClick={e => e.stopPropagation()}>⋮⋮</button>
            </div>
          );
        })}
      </div>

      <div className={styles.buttonRow}>
        <button className={styles.addButton} onClick={addVariable}>+ Variable</button>
      </div>
      </div>
      )}

      {mode === 'detail' && selected && (
        <div className={styles.detailEditor}>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e => updateVariable(selected.id, { name: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <input
                className={styles.textInput}
                value={selected.description ?? ''}
                placeholder="(optional)"
                onChange={e => updateVariable(selected.id, { description: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Kind</label>
              <select
                className={styles.selectInput}
                value={selected.kind}
                onChange={e => updateVariable(selected.id, { kind: e.target.value as VariableKind })}
              >
                <option value="scalar">Scalar</option>
                <option value="array">Array</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Data Type</label>
              <select
                className={styles.selectInput}
                value={selected.dataType}
                onChange={e => {
                  const dt = e.target.value as VariableDataType;
                  const defaults: Record<string, string> = {
                    bool: 'false', integer: '0', float: '0', tag: '0',
                  };
                  updateVariable(selected.id, {
                    dataType: dt,
                    initialValue: defaults[dt] || '0',
                  });
                }}
              >
                <option value="bool">Bool</option>
                <option value="integer">Integer</option>
                <option value="float">Float</option>
                <option value="tag">Tag</option>
              </select>
            </div>

            {selected.kind === 'array' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Length</label>
                <input
                  className={styles.numberInput}
                  type="number"
                  min="1"
                  max="65536"
                  value={selected.length ?? 4}
                  onChange={e => updateVariable(selected.id, { length: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                />
              </div>
            )}

            {selected.dataType === 'tag' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Tag Attribute</label>
                <select
                  className={styles.selectInput}
                  value={selected.attributeId ?? ''}
                  onChange={e => updateVariable(selected.id, { attributeId: e.target.value || undefined })}
                >
                  <option value="">Select tag attribute...</option>
                  {tagAttrs.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Initial Value</label>
              {selected.dataType === 'bool' ? (
                <select
                  className={styles.selectInput}
                  value={selected.initialValue === 'true' || selected.initialValue === '1' ? 'true' : 'false'}
                  onChange={e => updateVariable(selected.id, { initialValue: e.target.value })}
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              ) : selected.dataType === 'tag' && selTagAttr?.tagOptions ? (
                <select
                  className={styles.selectInput}
                  value={selected.initialValue || '0'}
                  onChange={e => updateVariable(selected.id, { initialValue: e.target.value })}
                >
                  {selTagAttr.tagOptions.map((name, idx) => (
                    <option key={idx} value={String(idx)}>{name}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={styles.numberInput}
                  type="number"
                  step={selected.dataType === 'integer' ? '1' : 'any'}
                  value={selected.initialValue}
                  onChange={e => updateVariable(selected.id, { initialValue: e.target.value })}
                />
              )}
            </div>

            <button
              className={styles.deleteButton}
              onClick={() => { removeVariable(selected.id); setSelectedId(null); }}
            >
              Delete Variable
            </button>
          </div>
        </div>
      )}
    </>
  );
}

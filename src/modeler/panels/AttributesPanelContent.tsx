import { useState, useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import type { AttributeType } from '../../model/types';
import { useListReorder } from './useListReorder';
import styles from './PanelContent.module.css';

export function AttributesPanelContent() {
  const { model, addAttribute, removeAttribute, updateAttribute, reorderAttributes } = useModel();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);

  // Independent reorder within each group — preserve the other group's order in the combined array.
  const cellReorder = useListReorder(cellAttrs, newOrder => {
    const map = new Map(cellAttrs.map(a => [a.id, a]));
    reorderAttributes([...newOrder.map(id => map.get(id)!).filter(Boolean), ...modelAttrs].map(a => a.id));
  });
  const modelReorder = useListReorder(modelAttrs, newOrder => {
    const map = new Map(modelAttrs.map(a => [a.id, a]));
    reorderAttributes([...cellAttrs, ...newOrder.map(id => map.get(id)!).filter(Boolean)].map(a => a.id));
  });

  // Auto-select & scroll to newly added items
  const prevAttrCount = useRef(model.attributes.length);
  useEffect(() => {
    if (model.attributes.length > prevAttrCount.current) {
      const newItem = model.attributes[model.attributes.length - 1];
      if (newItem) {
        setSelectedId(newItem.id);
        setTimeout(() => {
          document.getElementById(`attr-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevAttrCount.current = model.attributes.length;
  }, [model.attributes]);
  const selected = model.attributes.find(a => a.id === selectedId);

  const handleDelete = () => {
    if (selectedId) {
      removeAttribute(selectedId);
      setSelectedId(null);
    }
  };

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Cell Attributes</div>
        <div className={styles.list} data-reorder-list>
          {cellAttrs.map((attr, i) => {
            const isDragging = cellReorder.dragState?.id === attr.id;
            const srcIdx = cellReorder.dragState ? cellAttrs.findIndex(a => a.id === cellReorder.dragState!.id) : -1;
            const showBefore = cellReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = cellReorder.dragState?.overIdx === cellAttrs.length && i === cellAttrs.length - 1 && srcIdx !== i;
            return (
              <div
                key={attr.id}
                id={`attr-${attr.id}`}
                data-reorder-row
                className={`${styles.listItem} ${selectedId === attr.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedId(attr.id)}
              >
                <span className={styles.listItemName}>{attr.name}</span>
                <span className={styles.listItemBadge}>{attr.type}</span>
                <button
                  className={styles.dragHandle}
                  title="Drag to reorder"
                  onPointerDown={cellReorder.startDrag(attr.id)}
                  onClick={e => e.stopPropagation()}
                >⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addAttribute(false)}
          >
            + Add Cell Attribute
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Model Attributes</div>
        <div className={styles.list} data-reorder-list>
          {modelAttrs.length === 0 && (
            <p
              style={{
                fontSize: '0.75rem',
                color: '#6080a0',
                fontStyle: 'italic',
                padding: '4px 0',
              }}
            >
              No model attributes defined.
            </p>
          )}
          {modelAttrs.map((attr, i) => {
            const isDragging = modelReorder.dragState?.id === attr.id;
            const srcIdx = modelReorder.dragState ? modelAttrs.findIndex(a => a.id === modelReorder.dragState!.id) : -1;
            const showBefore = modelReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = modelReorder.dragState?.overIdx === modelAttrs.length && i === modelAttrs.length - 1 && srcIdx !== i;
            return (
              <div
                key={attr.id}
                id={`attr-${attr.id}`}
                data-reorder-row
                className={`${styles.listItem} ${selectedId === attr.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedId(attr.id)}
              >
                <span className={styles.listItemName}>{attr.name}</span>
                <span className={styles.listItemBadge}>{attr.type}</span>
                <button
                  className={styles.dragHandle}
                  title="Drag to reorder"
                  onPointerDown={modelReorder.startDrag(attr.id)}
                  onClick={e => e.stopPropagation()}
                >⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addAttribute(true)}
          >
            + Add Model Attribute
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {selected && (
        <div className={styles.detailEditor}>
          <div className={styles.detailTitle}>Edit: {selected.name}</div>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e =>
                  updateAttribute(selected.id, { name: e.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Type</label>
              <select
                className={styles.selectInput}
                value={selected.type}
                onChange={e => {
                  const newType = e.target.value as AttributeType;
                  const resetDefaults: Record<string, string> = {
                    bool: 'false', integer: '0', float: '0', list: '', tag: '', color: '#808080',
                  };
                  updateAttribute(selected.id, {
                    type: newType,
                    defaultValue: resetDefaults[newType] ?? '',
                  });
                }}
              >
                <option value="bool">Bool</option>
                <option value="integer">Integer</option>
                <option value="float">Float</option>
                <option value="tag">Tag</option>
                {selected.isModelAttribute && <option value="color">Color</option>}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Default Value</label>
              {selected.type === 'bool' ? (
                <select
                  className={styles.selectInput}
                  value={selected.defaultValue === 'true' ? 'true' : 'false'}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              ) : selected.type === 'integer' ? (
                <input
                  className={styles.numberInput}
                  type="number"
                  step={1}
                  value={selected.defaultValue}
                  onChange={e =>
                    updateAttribute(selected.id, {
                      defaultValue: String(Math.round(Number(e.target.value) || 0)),
                    })
                  }
                />
              ) : selected.type === 'float' ? (
                <input
                  className={styles.numberInput}
                  type="number"
                  step="any"
                  value={selected.defaultValue}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                />
              ) : selected.type === 'color' ? (
                <input
                  type="color"
                  value={selected.defaultValue || '#808080'}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                  style={{ width: '100%', height: 30, border: 'none', cursor: 'pointer' }}
                />
              ) : selected.type === 'tag' ? (
                <select
                  className={styles.selectInput}
                  value={selected.defaultValue || '0'}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                >
                  {(selected.tagOptions || []).map((tag, i) => (
                    <option key={i} value={String(i)}>{tag}</option>
                  ))}
                  {(!selected.tagOptions || selected.tagOptions.length === 0) && (
                    <option value="0">(no tags defined)</option>
                  )}
                </select>
              ) : (
                <input
                  className={styles.textInput}
                  value={selected.defaultValue}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                />
              )}
            </div>

            {/* Boundary Value — cell attributes only, shown when boundary treatment is constant. */}
            {!selected.isModelAttribute && model.properties.boundaryTreatment === 'constant' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} title="Value held by out-of-grid cells when boundary is constant. Blank = use Default Value.">
                  Boundary Value
                </label>
                {selected.type === 'bool' ? (
                  <select
                    className={styles.selectInput}
                    value={selected.boundaryValue ?? selected.defaultValue}
                    onChange={e => updateAttribute(selected.id, { boundaryValue: e.target.value })}
                  >
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                ) : selected.type === 'integer' ? (
                  <input
                    className={styles.numberInput}
                    type="number"
                    step={1}
                    value={selected.boundaryValue ?? ''}
                    placeholder={`(default: ${selected.defaultValue})`}
                    onChange={e => updateAttribute(selected.id, {
                      boundaryValue: e.target.value === '' ? undefined : String(Math.round(Number(e.target.value) || 0)),
                    })}
                  />
                ) : selected.type === 'float' ? (
                  <input
                    className={styles.numberInput}
                    type="number"
                    step="any"
                    value={selected.boundaryValue ?? ''}
                    placeholder={`(default: ${selected.defaultValue})`}
                    onChange={e => updateAttribute(selected.id, {
                      boundaryValue: e.target.value === '' ? undefined : e.target.value,
                    })}
                  />
                ) : selected.type === 'tag' ? (
                  <select
                    className={styles.selectInput}
                    value={selected.boundaryValue ?? selected.defaultValue ?? '0'}
                    onChange={e => updateAttribute(selected.id, { boundaryValue: e.target.value })}
                  >
                    {(selected.tagOptions || []).map((tag, i) => (
                      <option key={i} value={String(i)}>{tag}</option>
                    ))}
                    {(!selected.tagOptions || selected.tagOptions.length === 0) && (
                      <option value="0">(no tags defined)</option>
                    )}
                  </select>
                ) : (
                  <input
                    className={styles.textInput}
                    value={selected.boundaryValue ?? ''}
                    placeholder={`(default: ${selected.defaultValue})`}
                    onChange={e => updateAttribute(selected.id, {
                      boundaryValue: e.target.value === '' ? undefined : e.target.value,
                    })}
                  />
                )}
              </div>
            )}

            {selected.type === 'tag' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Tag Options</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(selected.tagOptions || []).map((tag, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: '0.7rem', color: '#6080a0', width: 16 }}>{i}</span>
                      <input
                        className={styles.textInput}
                        value={tag}
                        onChange={e => {
                          const opts = [...(selected.tagOptions || [])];
                          opts[i] = e.target.value;
                          updateAttribute(selected.id, { tagOptions: opts });
                        }}
                        style={{ flex: 1 }}
                      />
                      <button
                        className={styles.deleteButton}
                        style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                        onClick={() => {
                          const opts = (selected.tagOptions || []).filter((_, j) => j !== i);
                          updateAttribute(selected.id, { tagOptions: opts });
                        }}
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                  <button
                    className={styles.addButton}
                    style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                    onClick={() => {
                      const opts = [...(selected.tagOptions || []), `tag_${(selected.tagOptions || []).length}`];
                      updateAttribute(selected.id, { tagOptions: opts });
                    }}
                  >
                    + Add Tag
                  </button>
                </div>
              </div>
            )}

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.textArea}
                rows={3}
                value={selected.description}
                onChange={e =>
                  updateAttribute(selected.id, {
                    description: e.target.value,
                  })
                }
              />
            </div>

            {selected.isModelAttribute && (selected.type === 'integer' || selected.type === 'float') && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={selected.hasBounds ?? false}
                    onChange={e => updateAttribute(selected.id, {
                      hasBounds: e.target.checked,
                      min: selected.min ?? 0,
                      max: selected.max ?? (selected.type === 'integer' ? 100 : 1),
                    })}
                  />
                  Enable Bounds
                </label>
                {selected.hasBounds && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <div style={{ flex: 1 }}>
                      <label className={styles.fieldLabel}>Min</label>
                      <input
                        className={styles.numberInput}
                        type="number"
                        step={selected.type === 'integer' ? 1 : 'any'}
                        value={selected.min ?? 0}
                        onChange={e => updateAttribute(selected.id, {
                          min: selected.type === 'integer' ? Math.round(Number(e.target.value) || 0) : Number(e.target.value) || 0,
                        })}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className={styles.fieldLabel}>Max</label>
                      <input
                        className={styles.numberInput}
                        type="number"
                        step={selected.type === 'integer' ? 1 : 'any'}
                        value={selected.max ?? (selected.type === 'integer' ? 100 : 1)}
                        onChange={e => updateAttribute(selected.id, {
                          max: selected.type === 'integer' ? Math.round(Number(e.target.value) || 0) : Number(e.target.value) || 0,
                        })}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

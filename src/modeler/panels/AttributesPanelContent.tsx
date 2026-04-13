import { useState, useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import type { AttributeType } from '../../model/types';
import styles from './PanelContent.module.css';

export function AttributesPanelContent() {
  const { model, addAttribute, removeAttribute, updateAttribute } = useModel();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);

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
        <div className={styles.list}>
          {cellAttrs.map(attr => (
            <div
              key={attr.id}
              id={`attr-${attr.id}`}
              className={`${styles.listItem} ${selectedId === attr.id ? styles.listItemSelected : ''}`}
              onClick={() => setSelectedId(attr.id)}
            >
              <span className={styles.listItemName}>{attr.name}</span>
              <span className={styles.listItemBadge}>{attr.type}</span>
            </div>
          ))}
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
        <div className={styles.list}>
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
          {modelAttrs.map(attr => (
            <div
              key={attr.id}
              id={`attr-${attr.id}`}
              className={`${styles.listItem} ${selectedId === attr.id ? styles.listItemSelected : ''}`}
              onClick={() => setSelectedId(attr.id)}
            >
              <span className={styles.listItemName}>{attr.name}</span>
              <span className={styles.listItemBadge}>{attr.type}</span>
            </div>
          ))}
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
          </div>
        </div>
      )}
    </>
  );
}

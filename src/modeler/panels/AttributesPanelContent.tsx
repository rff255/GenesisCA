import { useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type { AttributeType } from '../../model/types';
import styles from './PanelContent.module.css';

export function AttributesPanelContent() {
  const { model, addAttribute, removeAttribute, updateAttribute } = useModel();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);
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
                onChange={e =>
                  updateAttribute(selected.id, {
                    type: e.target.value as AttributeType,
                  })
                }
              >
                <option value="bool">Bool</option>
                <option value="integer">Integer</option>
                <option value="float">Float</option>
                <option value="list">List</option>
                <option value="tag">Tag</option>
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Default Value</label>
              <input
                className={styles.textInput}
                value={selected.defaultValue}
                onChange={e =>
                  updateAttribute(selected.id, {
                    defaultValue: e.target.value,
                  })
                }
              />
            </div>
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

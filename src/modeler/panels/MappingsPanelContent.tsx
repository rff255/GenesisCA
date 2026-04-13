import { useState, useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import styles from './PanelContent.module.css';

export function MappingsPanelContent() {
  const { model, addMapping, removeMapping, updateMapping } = useModel();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const attrToColor = model.mappings.filter(m => m.isAttributeToColor);
  const colorToAttr = model.mappings.filter(m => !m.isAttributeToColor);

  // Auto-select & scroll to newly added mappings
  const prevCount = useRef(model.mappings.length);
  useEffect(() => {
    if (model.mappings.length > prevCount.current) {
      const newItem = model.mappings[model.mappings.length - 1];
      if (newItem) {
        setSelectedId(newItem.id);
        setTimeout(() => {
          document.getElementById(`mapping-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevCount.current = model.mappings.length;
  }, [model.mappings]);
  const selected = model.mappings.find(m => m.id === selectedId);

  const handleDelete = () => {
    if (selectedId) {
      removeMapping(selectedId);
      setSelectedId(null);
    }
  };

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Attribute &rarr; Color (Output)
        </div>
        <div className={styles.list}>
          {attrToColor.map(m => (
            <div
              key={m.id}
              id={`mapping-${m.id}`}
              className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''}`}
              onClick={() => setSelectedId(m.id)}
            >
              <span className={styles.listItemName}>{m.name}</span>
              <span className={styles.listItemBadge}>A&rarr;C</span>
            </div>
          ))}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addMapping(true)}
          >
            + Add A&rarr;C Mapping
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Color &rarr; Attribute (Input)
        </div>
        <div className={styles.list}>
          {colorToAttr.map(m => (
            <div
              key={m.id}
              id={`mapping-${m.id}`}
              className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''}`}
              onClick={() => setSelectedId(m.id)}
            >
              <span className={styles.listItemName}>{m.name}</span>
              <span className={styles.listItemBadge}>C&rarr;A</span>
            </div>
          ))}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addMapping(false)}
          >
            + Add C&rarr;A Mapping
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
                  updateMapping(selected.id, { name: e.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.description}
                onChange={e =>
                  updateMapping(selected.id, { description: e.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelRed}`}
              >
                Red Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.redDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    redDescription: e.target.value,
                  })
                }
              />
            </div>
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelGreen}`}
              >
                Green Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.greenDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    greenDescription: e.target.value,
                  })
                }
              />
            </div>
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelBlue}`}
              >
                Blue Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.blueDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    blueDescription: e.target.value,
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

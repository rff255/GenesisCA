import { useState } from 'react';
import styles from './PanelContent.module.css';

interface MockAttribute {
  id: string;
  name: string;
  type: string;
  isModel: boolean;
  description: string;
}

const MOCK_ATTRIBUTES: MockAttribute[] = [
  { id: 'alive', name: 'alive', type: 'Bool', isModel: false, description: 'Whether the cell is alive or dead' },
  { id: 'age', name: 'age', type: 'Integer', isModel: false, description: 'How many generations the cell has been alive' },
];

export function AttributesPanelContent() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const cellAttrs = MOCK_ATTRIBUTES.filter(a => !a.isModel);
  const modelAttrs = MOCK_ATTRIBUTES.filter(a => a.isModel);
  const selected = MOCK_ATTRIBUTES.find(a => a.id === selectedId);

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
          <button className={styles.addButton}>+ Add Cell Attribute</button>
          <button className={styles.deleteButton}>Delete</button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Model Attributes</div>
        <div className={styles.list}>
          {modelAttrs.length === 0 && (
            <p style={{ fontSize: '0.75rem', color: '#6080a0', fontStyle: 'italic', padding: '4px 0' }}>
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
          <button className={styles.addButton}>+ Add Model Attribute</button>
          <button className={styles.deleteButton}>Delete</button>
        </div>
      </div>

      {selected && (
        <div className={styles.detailEditor}>
          <div className={styles.detailTitle}>Edit: {selected.name}</div>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input className={styles.textInput} defaultValue={selected.name} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Type</label>
              <select className={styles.selectInput} defaultValue={selected.type}>
                <option value="Bool">Bool</option>
                <option value="Integer">Integer</option>
                <option value="Float">Float</option>
                <option value="List">List</option>
                <option value="Tag">Tag</option>
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea className={styles.textArea} rows={3} defaultValue={selected.description} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

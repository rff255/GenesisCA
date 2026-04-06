import { useState } from 'react';
import styles from './PanelContent.module.css';

interface MockMapping {
  id: string;
  name: string;
  isAttrToColor: boolean;
  description: string;
  red: string;
  green: string;
  blue: string;
}

const MOCK_MAPPINGS: MockMapping[] = [
  {
    id: 'default-viz',
    name: 'Default Visualization',
    isAttrToColor: true,
    description: 'Maps alive state to cell color',
    red: 'alive ? 76 : 13',
    green: 'alive ? 201 : 27',
    blue: 'alive ? 240 : 43',
  },
  {
    id: 'paint',
    name: 'Paint Interaction',
    isAttrToColor: false,
    description: 'Allows painting alive cells on the grid',
    red: 'ignored',
    green: 'ignored',
    blue: 'brightness > 128 → alive = true',
  },
];

export function MappingsPanelContent() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const attrToColor = MOCK_MAPPINGS.filter(m => m.isAttrToColor);
  const colorToAttr = MOCK_MAPPINGS.filter(m => !m.isAttrToColor);
  const selected = MOCK_MAPPINGS.find(m => m.id === selectedId);

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Attribute &rarr; Color (Output)</div>
        <div className={styles.list}>
          {attrToColor.map(m => (
            <div
              key={m.id}
              className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''}`}
              onClick={() => setSelectedId(m.id)}
            >
              <span className={styles.listItemName}>{m.name}</span>
              <span className={styles.listItemBadge}>A&rarr;C</span>
            </div>
          ))}
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.addButton}>+ Add A&rarr;C Mapping</button>
          <button className={styles.deleteButton}>Delete</button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Color &rarr; Attribute (Input)</div>
        <div className={styles.list}>
          {colorToAttr.map(m => (
            <div
              key={m.id}
              className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''}`}
              onClick={() => setSelectedId(m.id)}
            >
              <span className={styles.listItemName}>{m.name}</span>
              <span className={styles.listItemBadge}>C&rarr;A</span>
            </div>
          ))}
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.addButton}>+ Add C&rarr;A Mapping</button>
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
              <label className={styles.fieldLabel}>Description</label>
              <textarea className={styles.textArea} rows={2} defaultValue={selected.description} />
            </div>
            <div className={styles.field}>
              <span className={`${styles.colorLabel} ${styles.colorLabelRed}`}>Red Channel</span>
              <textarea className={styles.textArea} rows={2} defaultValue={selected.red} />
            </div>
            <div className={styles.field}>
              <span className={`${styles.colorLabel} ${styles.colorLabelGreen}`}>Green Channel</span>
              <textarea className={styles.textArea} rows={2} defaultValue={selected.green} />
            </div>
            <div className={styles.field}>
              <span className={`${styles.colorLabel} ${styles.colorLabelBlue}`}>Blue Channel</span>
              <textarea className={styles.textArea} rows={2} defaultValue={selected.blue} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

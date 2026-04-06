import styles from './PanelContent.module.css';

export function PropertiesPanelContent() {
  return (
    <div className={styles.fieldGroup}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Presentation</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input className={styles.textInput} defaultValue="Game of Life" />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Author</label>
            <input className={styles.textInput} defaultValue="John Conway" />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Goal</label>
            <input className={styles.textInput} defaultValue="Classic cellular automaton demonstrating emergent behavior" />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Description</label>
            <textarea
              className={styles.textArea}
              rows={4}
              defaultValue="A zero-player game where evolution is determined by the initial state. Each cell is either alive or dead, and its next state depends on the number of alive neighbors."
            />
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Structure</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Boundary Treatment</label>
            <select className={styles.selectInput} defaultValue="torus">
              <option value="torus">Torus</option>
              <option value="constant">Constant</option>
            </select>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Width</label>
              <input className={styles.numberInput} type="number" defaultValue={100} min={1} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Height</label>
              <input className={styles.numberInput} type="number" defaultValue={100} min={1} />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Execution</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Max Iterations</label>
            <input className={styles.numberInput} type="number" defaultValue={1000} min={0} />
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Model Attribute Defaults</div>
        <div className={styles.fieldGroup}>
          <p style={{ fontSize: '0.75rem', color: '#6080a0', fontStyle: 'italic' }}>
            No model attributes defined. Add model attributes in the Attributes panel.
          </p>
        </div>
      </div>
    </div>
  );
}

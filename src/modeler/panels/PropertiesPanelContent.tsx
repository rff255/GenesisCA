import { useModel } from '../../model/ModelContext';
import type { BoundaryTreatment } from '../../model/types';
import styles from './PanelContent.module.css';

export function PropertiesPanelContent() {
  const { model, updateProperties, updateAttribute } = useModel();
  const { properties } = model;
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Presentation</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input
              className={styles.textInput}
              value={properties.name}
              onChange={e => updateProperties({ name: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Author</label>
            <input
              className={styles.textInput}
              value={properties.author}
              onChange={e => updateProperties({ author: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Goal</label>
            <input
              className={styles.textInput}
              value={properties.goal}
              onChange={e => updateProperties({ goal: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Description</label>
            <textarea
              className={styles.textArea}
              rows={4}
              value={properties.description}
              onChange={e => updateProperties({ description: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Structure</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Boundary Treatment</label>
            <select
              className={styles.selectInput}
              value={properties.boundaryTreatment}
              onChange={e =>
                updateProperties({
                  boundaryTreatment: e.target.value as BoundaryTreatment,
                })
              }
            >
              <option value="torus">Torus</option>
              <option value="constant">Constant</option>
            </select>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Width</label>
              <input
                className={styles.numberInput}
                type="number"
                value={properties.gridWidth}
                min={1}
                onChange={e =>
                  updateProperties({ gridWidth: Number(e.target.value) || 1 })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Height</label>
              <input
                className={styles.numberInput}
                type="number"
                value={properties.gridHeight}
                min={1}
                onChange={e =>
                  updateProperties({ gridHeight: Number(e.target.value) || 1 })
                }
              />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Execution</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Max Iterations</label>
            <input
              className={styles.numberInput}
              type="number"
              value={properties.maxIterations}
              min={0}
              onChange={e =>
                updateProperties({ maxIterations: Number(e.target.value) || 0 })
              }
            />
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Model Attribute Defaults</div>
        <div className={styles.fieldGroup}>
          {modelAttrs.length === 0 ? (
            <p
              style={{
                fontSize: '0.75rem',
                color: '#6080a0',
                fontStyle: 'italic',
              }}
            >
              No model attributes defined. Add model attributes in the
              Attributes panel.
            </p>
          ) : (
            modelAttrs.map(attr => (
              <div key={attr.id} className={styles.field}>
                <label className={styles.fieldLabel}>{attr.name}</label>
                <input
                  className={styles.textInput}
                  value={attr.defaultValue}
                  onChange={e =>
                    updateAttribute(attr.id, { defaultValue: e.target.value })
                  }
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

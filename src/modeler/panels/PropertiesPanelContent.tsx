import { useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type { BoundaryTreatment, UpdateMode, AsyncScheme } from '../../model/types';
import { IndicatorsPanelSection } from './IndicatorsPanelSection';
import styles from './PanelContent.module.css';

export function PropertiesPanelContent() {
  const { model, updateProperties } = useModel();
  const { properties } = model;
  const [tagInput, setTagInput] = useState('');

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (!tag || (properties.tags || []).includes(tag)) return;
    updateProperties({ tags: [...(properties.tags || []), tag] });
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    updateProperties({ tags: (properties.tags || []).filter(t => t !== tag) });
  };

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
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Tags</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
              {(properties.tags || []).map(tag => (
                <span
                  key={tag}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '1px 8px', background: 'rgba(76,201,240,0.12)',
                    border: '1px solid rgba(76,201,240,0.25)', borderRadius: 10,
                    fontSize: '0.68rem', color: '#4cc9f0',
                  }}
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    style={{
                      background: 'none', border: 'none', color: '#f44336',
                      cursor: 'pointer', fontSize: '0.7rem', padding: 0, lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                className={styles.textInput}
                style={{ flex: 1 }}
                placeholder="Add tag..."
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              />
              <button className={styles.addButton} style={{ padding: '2px 8px' }} onClick={addTag}>+</button>
            </div>
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
            <label className={styles.fieldLabel}>Update Mode</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="updateMode"
                  value="synchronous"
                  checked={properties.updateMode !== 'asynchronous'}
                  onChange={() => updateProperties({ updateMode: 'synchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Synchronous</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    All cells read from the previous generation and write to the next simultaneously. Classic CA behavior.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="updateMode"
                  value="asynchronous"
                  checked={properties.updateMode === 'asynchronous'}
                  onChange={() => updateProperties({ updateMode: 'asynchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Asynchronous</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Cells update one at a time using a single buffer. Each cell sees previous updates within the same generation. Enables number-conserving models.
                  </span>
                </span>
              </label>
            </div>
          </div>
          {properties.updateMode === 'asynchronous' && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Asynchronous Update Scheme</label>
              <select
                className={styles.selectInput}
                value={properties.asyncScheme || 'random-order'}
                onChange={e =>
                  updateProperties({ asyncScheme: e.target.value as AsyncScheme })
                }
              >
                <option value="random-order">Random Order</option>
                <option value="random-independent">Random Independent</option>
                <option value="cyclic">Cyclic</option>
              </select>
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
                {(properties.asyncScheme || 'random-order') === 'random-order' &&
                  'All cells update once per generation in random order (Fisher-Yates shuffle).'}
                {properties.asyncScheme === 'random-independent' &&
                  'N random cell picks with replacement per generation. Some cells may update 0 or 2+ times.'}
                {properties.asyncScheme === 'cyclic' &&
                  'A fixed random order decided at initialization, reused every generation. Fastest option.'}
              </span>
            </div>
          )}
        </div>
      </div>

      <IndicatorsPanelSection />
    </div>
  );
}

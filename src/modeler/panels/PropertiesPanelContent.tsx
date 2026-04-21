import { useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type {
  BoundaryTreatment, UpdateMode, AsyncScheme,
  EndConditions, EndConditionOp, IndicatorEndCondition,
} from '../../model/types';
import { IndicatorsPanelSection } from './IndicatorsPanelSection';
import styles from './PanelContent.module.css';

function newCondId(): string {
  return `ec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function PropertiesPanelContent() {
  const { model, updateProperties } = useModel();
  const { properties } = model;
  const [tagInput, setTagInput] = useState('');

  const ec = properties.endConditions;
  const ecEnabled = !!ec?.enabled;
  const updateEndConditions = (changes: Partial<EndConditions>) => {
    updateProperties({
      endConditions: {
        enabled: ecEnabled,
        maxGenerations: ec?.maxGenerations,
        indicatorConditions: ec?.indicatorConditions,
        ...changes,
      },
    });
  };
  const addIndicatorCondition = () => {
    const firstIndicator = (model.indicators || [])[0];
    if (!firstIndicator) return;
    const cond: IndicatorEndCondition = {
      id: newCondId(),
      indicatorId: firstIndicator.id,
      op: '==',
      value: firstIndicator.defaultValue ?? '0',
    };
    updateEndConditions({ indicatorConditions: [...(ec?.indicatorConditions || []), cond] });
  };
  const updateIndicatorCondition = (id: string, changes: Partial<IndicatorEndCondition>) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).map(c =>
        c.id === id ? { ...c, ...changes } : c,
      ),
    });
  };
  const removeIndicatorCondition = (id: string) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).filter(c => c.id !== id),
    });
  };

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
            <label className={styles.fieldLabel}>Rule Author</label>
            <input
              className={styles.textInput}
              value={properties.author}
              onChange={e => updateProperties({ author: e.target.value })}
              placeholder="Originator of the CA rule"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>GenesisCA Model Author</label>
            <input
              className={styles.textInput}
              value={properties.modelAuthor}
              onChange={e => updateProperties({ modelAuthor: e.target.value })}
              placeholder="Who built this GenesisCA model"
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

          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!properties.useWasm}
                onChange={(e) => updateProperties({ useWasm: e.target.checked })}
              />
              <span style={{ fontSize: '0.78rem' }}>Use WebAssembly (experimental)</span>
            </label>
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
              Experimental optimization. When on, the simulator runs the graph as a hand-compiled WASM module
              instead of JavaScript — typically several times faster on dense neighborhoods. Falls back to JS
              automatically when the graph uses a node type whose WASM emit is not yet implemented. Some node
              combinations are not yet bit-exact between the two backends, so toggle off if you observe a
              behaviour difference; the simulator restarts on change.
            </span>
          </div>

          {/* End Conditions — optional, collapsible */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={ecEnabled}
                onChange={e => updateEndConditions({ enabled: e.target.checked })}
              />
              <span style={{ fontSize: '0.78rem' }}>End Conditions</span>
            </label>
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
              When enabled, the simulator auto-pauses once any of these conditions are met
              (max generations reached, or any indicator rule matches).
            </span>
            {ecEnabled && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Max Generations</label>
                  <input
                    className={styles.numberInput}
                    type="number"
                    min={0}
                    placeholder="(no limit)"
                    value={ec?.maxGenerations ?? ''}
                    onChange={e => updateEndConditions({
                      maxGenerations: e.target.value === '' ? undefined : Math.max(0, Math.round(Number(e.target.value) || 0)),
                    })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Indicator Conditions</label>
                  {(model.indicators || []).length === 0 && (
                    <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>
                      Define at least one indicator to add conditions.
                    </span>
                  )}
                  {(ec?.indicatorConditions || []).map(cond => {
                    const ind = (model.indicators || []).find(i => i.id === cond.indicatorId);
                    return (
                      <div key={cond.id} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
                        <select
                          className={styles.selectInput}
                          style={{ flex: 1.4 }}
                          value={cond.indicatorId}
                          onChange={e => updateIndicatorCondition(cond.id, { indicatorId: e.target.value })}
                        >
                          {(model.indicators || []).map(i => (
                            <option key={i.id} value={i.id}>{i.name}</option>
                          ))}
                        </select>
                        <select
                          className={styles.selectInput}
                          style={{ width: 52 }}
                          value={cond.op}
                          onChange={e => updateIndicatorCondition(cond.id, { op: e.target.value as EndConditionOp })}
                        >
                          <option value="==">==</option>
                          <option value="!=">!=</option>
                          <option value=">">&gt;</option>
                          <option value="<">&lt;</option>
                          <option value=">=">&ge;</option>
                          <option value="<=">&le;</option>
                        </select>
                        {ind?.dataType === 'bool' ? (
                          <select
                            className={styles.selectInput}
                            style={{ flex: 1 }}
                            value={cond.value === '1' || cond.value === 'true' ? 'true' : 'false'}
                            onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                          >
                            <option value="false">false</option>
                            <option value="true">true</option>
                          </select>
                        ) : ind?.dataType === 'tag' ? (
                          <select
                            className={styles.selectInput}
                            style={{ flex: 1 }}
                            value={cond.value}
                            onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                          >
                            {(ind.tagOptions || []).map((tag, i) => (
                              <option key={i} value={String(i)}>{tag}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className={styles.numberInput}
                            type="number"
                            step={ind?.dataType === 'integer' ? 1 : 'any'}
                            style={{ flex: 1 }}
                            value={cond.value}
                            onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                          />
                        )}
                        <button
                          className={styles.deleteButton}
                          style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                          onClick={() => removeIndicatorCondition(cond.id)}
                          title="Remove condition"
                        >
                          &times;
                        </button>
                      </div>
                    );
                  })}
                  <button
                    className={styles.addButton}
                    style={{ fontSize: '0.72rem', padding: '2px 8px', marginTop: 4 }}
                    disabled={(model.indicators || []).length === 0}
                    onClick={addIndicatorCondition}
                  >
                    + Add Indicator Condition
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <IndicatorsPanelSection />
    </div>
  );
}

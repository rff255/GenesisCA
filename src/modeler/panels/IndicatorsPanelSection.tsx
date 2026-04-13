import { useState, useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import type { AttributeType, LinkedAggregation } from '../../model/types';
import styles from './PanelContent.module.css';

export function IndicatorsPanelSection() {
  const { model, addIndicator, removeIndicator, updateIndicator } = useModel();
  const indicators = model.indicators || [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select & scroll to newly added indicators
  const prevCount = useRef(indicators.length);
  useEffect(() => {
    if (indicators.length > prevCount.current) {
      const newItem = indicators[indicators.length - 1];
      if (newItem) {
        setSelectedId(newItem.id);
        setTimeout(() => {
          document.getElementById(`ind-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevCount.current = indicators.length;
  }, [indicators]);
  const selected = indicators.find(i => i.id === selectedId);

  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);

  const getAggregationOptions = (attrType: string): Array<{ value: LinkedAggregation; label: string }> => {
    switch (attrType) {
      case 'bool': return [{ value: 'frequency', label: 'Frequency' }];
      case 'tag':  return [{ value: 'frequency', label: 'Frequency' }];
      case 'integer':
      case 'float':
        return [
          { value: 'total', label: 'Total (Sum)' },
          { value: 'frequency', label: 'Frequency' },
        ];
      default: return [{ value: 'frequency', label: 'Frequency' }];
    }
  };

  const linkedAttr = selected?.kind === 'linked'
    ? cellAttrs.find(a => a.id === selected.linkedAttributeId)
    : undefined;

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Indicators</div>

      <div className={styles.list}>
        {indicators.map(ind => (
          <div
            key={ind.id}
            id={`ind-${ind.id}`}
            className={`${styles.listItem} ${ind.id === selectedId ? styles.listItemSelected : ''}`}
            onClick={() => setSelectedId(ind.id === selectedId ? null : ind.id)}
          >
            <span className={styles.listItemName}>{ind.name}</span>
            <span className={styles.listItemBadge}>{ind.kind === 'standalone' ? 'Standalone' : 'Linked'}</span>
          </div>
        ))}
      </div>

      <div className={styles.buttonRow}>
        <button className={styles.addButton} onClick={() => addIndicator('standalone')}>+ Standalone</button>
        <button className={styles.addButton} onClick={() => addIndicator('linked')}>+ Linked</button>
      </div>

      {selected && (
        <div className={styles.detailEditor}>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e => updateIndicator(selected.id, { name: e.target.value })}
              />
            </div>

            {selected.kind === 'standalone' && (
              <>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Data Type</label>
                  <select
                    className={styles.selectInput}
                    value={selected.dataType || 'integer'}
                    onChange={e => {
                      const dt = e.target.value as AttributeType;
                      const defaults: Record<string, string> = {
                        bool: 'false', integer: '0', float: '0', tag: '0',
                      };
                      updateIndicator(selected.id, {
                        dataType: dt,
                        defaultValue: defaults[dt] || '0',
                        tagOptions: dt === 'tag' ? [] : undefined,
                      });
                    }}
                  >
                    <option value="bool">Bool</option>
                    <option value="integer">Integer</option>
                    <option value="float">Float</option>
                    <option value="tag">Tag</option>
                  </select>
                </div>

                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Default Value</label>
                  {selected.dataType === 'bool' ? (
                    <select
                      className={styles.selectInput}
                      value={selected.defaultValue === 'true' ? 'true' : 'false'}
                      onChange={e => updateIndicator(selected.id, { defaultValue: e.target.value })}
                    >
                      <option value="false">false</option>
                      <option value="true">true</option>
                    </select>
                  ) : selected.dataType === 'tag' ? (
                    <select
                      className={styles.selectInput}
                      value={selected.defaultValue || '0'}
                      onChange={e => updateIndicator(selected.id, { defaultValue: e.target.value })}
                    >
                      {(selected.tagOptions || []).length > 0
                        ? (selected.tagOptions || []).map((t, i) => (
                            <option key={i} value={String(i)}>{t}</option>
                          ))
                        : <option value="0">0</option>}
                    </select>
                  ) : (
                    <input
                      className={styles.numberInput}
                      type="number"
                      value={selected.defaultValue || '0'}
                      onChange={e => updateIndicator(selected.id, { defaultValue: e.target.value })}
                    />
                  )}
                </div>

                {selected.dataType === 'tag' && (
                  <TagOptionsEditor
                    options={selected.tagOptions || []}
                    onChange={opts => updateIndicator(selected.id, { tagOptions: opts })}
                  />
                )}
              </>
            )}

            {selected.kind === 'linked' && (
              <>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Linked Attribute</label>
                  <select
                    className={styles.selectInput}
                    value={selected.linkedAttributeId || ''}
                    onChange={e => {
                      const attr = cellAttrs.find(a => a.id === e.target.value);
                      const aggOpts = attr ? getAggregationOptions(attr.type) : [];
                      updateIndicator(selected.id, {
                        linkedAttributeId: e.target.value,
                        dataType: (attr?.type || 'integer') as AttributeType,
                        linkedAggregation: aggOpts[0]?.value || 'frequency',
                      });
                    }}
                  >
                    <option value="">Select...</option>
                    {cellAttrs.map(a => (
                      <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
                    ))}
                  </select>
                </div>

                {linkedAttr && (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Aggregation</label>
                    <select
                      className={styles.selectInput}
                      value={selected.linkedAggregation || 'frequency'}
                      onChange={e => updateIndicator(selected.id, { linkedAggregation: e.target.value as LinkedAggregation })}
                    >
                      {getAggregationOptions(linkedAttr.type).map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {linkedAttr?.type === 'float' && selected.linkedAggregation === 'frequency' && (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Bin Count</label>
                    <input
                      className={styles.numberInput}
                      type="number"
                      min={2}
                      max={100}
                      value={selected.binCount ?? 10}
                      onChange={e => updateIndicator(selected.id, { binCount: Math.max(2, Math.min(100, Number(e.target.value) || 10)) })}
                    />
                  </div>
                )}
              </>
            )}

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Accumulation</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                  <input
                    type="radio"
                    name={`accum_${selected.id}`}
                    checked={selected.accumulationMode !== 'accumulated'}
                    onChange={() => updateIndicator(selected.id, { accumulationMode: 'per-generation' })}
                  />
                  <span>Per Generation</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                  <input
                    type="radio"
                    name={`accum_${selected.id}`}
                    checked={selected.accumulationMode === 'accumulated'}
                    onChange={() => updateIndicator(selected.id, { accumulationMode: 'accumulated' })}
                  />
                  <span>Accumulated</span>
                </label>
              </div>
            </div>

            <button
              className={styles.deleteButton}
              onClick={() => { removeIndicator(selected.id); setSelectedId(null); }}
            >
              Delete Indicator
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TagOptionsEditor({ options, onChange }: { options: string[]; onChange: (opts: string[]) => void }) {
  const [input, setInput] = useState('');
  const add = () => {
    const val = input.trim();
    if (!val || options.includes(val)) return;
    onChange([...options, val]);
    setInput('');
  };
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>Tag Options</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {options.map((opt, i) => (
          <span
            key={i}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '1px 8px', background: 'rgba(76,201,240,0.12)',
              border: '1px solid rgba(76,201,240,0.25)', borderRadius: 10,
              fontSize: '0.68rem', color: '#4cc9f0',
            }}
          >
            {opt}
            <button
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              style={{
                background: 'none', border: 'none', color: '#f44336',
                cursor: 'pointer', fontSize: '0.7rem', padding: 0, lineHeight: 1,
              }}
            >x</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          className={styles.textInput}
          style={{ flex: 1 }}
          placeholder="Add option..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button className={styles.addButton} style={{ padding: '2px 8px', flex: 'none' }} onClick={add}>+</button>
      </div>
    </div>
  );
}

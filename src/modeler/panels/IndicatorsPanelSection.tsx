import { useState, useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import type { AttributeType, Indicator, IndicatorChartSettings, LinkedAggregation, IndicatorXAxis, SpatialBinMode, CAModel } from '../../model/types';
import { useListReorder } from './useListReorder';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag } from '../vpl/graphState';
import { useThemeTokens } from '../../styles/useThemeTokens';
import styles from './PanelContent.module.css';

function handleIndicatorDragStart(indicatorId: string) {
  return (e: React.DragEvent) => {
    const payload: ModelElementDragPayload = { kind: 'indicator', indicatorId };
    e.dataTransfer.setData(MODEL_ELEMENT_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
    setCurrentModelElementDrag(payload);
  };
}

function handleIndicatorDragEnd() {
  setCurrentModelElementDrag(null);
}

export function IndicatorsPanelSection() {
  const { model, addIndicator, removeIndicator, updateIndicator, reorderIndicators } = useModel();
  const indicators = model.indicators || [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reorder = useListReorder(indicators, reorderIndicators);

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

      <div className={styles.list} data-reorder-list>
        {indicators.map((ind, i) => {
          const isDragging = reorder.dragState?.id === ind.id;
          const srcIdx = reorder.dragState ? indicators.findIndex(x => x.id === reorder.dragState!.id) : -1;
          const showBefore = reorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
          const showAfter = reorder.dragState?.overIdx === indicators.length && i === indicators.length - 1 && srcIdx !== i;
          return (
            <div
              key={ind.id}
              id={`ind-${ind.id}`}
              data-reorder-row
              className={`${styles.listItem} ${ind.id === selectedId ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
              onClick={() => setSelectedId(ind.id === selectedId ? null : ind.id)}
              draggable
              onDragStart={handleIndicatorDragStart(ind.id)}
              onDragEnd={handleIndicatorDragEnd}
              title={`Drag to canvas to add a node that uses '${ind.name}'`}
            >
              <span className={styles.listItemName}>{ind.name}</span>
              <span className={styles.listItemBadge}>{ind.kind === 'standalone' ? 'Standalone' : 'Linked'}</span>
              <button className={styles.dragHandle} title="Drag to reorder"
                onPointerDown={reorder.startDrag(ind.id)}
                onClick={e => e.stopPropagation()}>⋮⋮</button>
            </div>
          );
        })}
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
                    <label className={styles.fieldLabel}>Value Bins</label>
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

                {/* Track Categories — bool/tag frequency only. Pick the subset of
                    category values to chart so a dominant one doesn't flatten the
                    rest on a shared Y-axis. Applies to both generation and spatial
                    (chromatogram) charts. */}
                {linkedAttr && (linkedAttr.type === 'bool' || linkedAttr.type === 'tag')
                  && selected.linkedAggregation === 'frequency' && (
                  <TrackCategoriesEditor
                    categories={linkedAttr.type === 'bool' ? ['true', 'false'] : (linkedAttr.tagOptions || [])}
                    tracked={selected.trackedValues}
                    onChange={tv => updateIndicator(selected.id, { trackedValues: tv })}
                  />
                )}

                {/* Spatial X-axis (chromatogram) — linked indicators only. The
                    'rows'/'columns' options turn the indicator into a live
                    position histogram instead of a generation time-history. */}
                {linkedAttr && (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>X Axis</label>
                    <select
                      className={styles.selectInput}
                      value={selected.xAxis || 'generation'}
                      onChange={e => updateIndicator(selected.id, { xAxis: e.target.value as IndicatorXAxis })}
                    >
                      <option value="generation">Generation (over time)</option>
                      <option value="rows">Rows (spatial)</option>
                      <option value="columns">Columns (spatial)</option>
                    </select>
                  </div>
                )}

                {linkedAttr && (selected.xAxis === 'rows' || selected.xAxis === 'columns') && (
                  <>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Bin Mode</label>
                      <select
                        className={styles.selectInput}
                        value={selected.spatialBinMode || 'slices'}
                        onChange={e => updateIndicator(selected.id, { spatialBinMode: e.target.value as SpatialBinMode })}
                      >
                        <option value="slices">Slices (relative count)</option>
                        <option value="absolute">Absolute ({selected.xAxis === 'rows' ? 'rows' : 'columns'} per bin)</option>
                      </select>
                    </div>
                    {(selected.spatialBinMode || 'slices') === 'slices' ? (
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Number of Slices</label>
                        <input
                          className={styles.numberInput}
                          type="number"
                          min={2}
                          max={1000}
                          value={selected.spatialBinCount ?? 50}
                          onChange={e => updateIndicator(selected.id, { spatialBinCount: Math.max(2, Math.min(1000, Number(e.target.value) || 50)) })}
                        />
                      </div>
                    ) : (
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>{selected.xAxis === 'rows' ? 'Rows' : 'Columns'} per Bin</label>
                        <input
                          className={styles.numberInput}
                          type="number"
                          min={1}
                          max={1000}
                          value={selected.spatialBinSize ?? 1}
                          onChange={e => updateIndicator(selected.id, { spatialBinSize: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
                        />
                      </div>
                    )}
                  </>
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

            <ChartDefaultsEditor
              indicator={selected}
              model={model}
              onChange={chartSettings => updateIndicator(selected.id, { chartSettings })}
            />

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

/** Design-time enumerable series keys for an indicator's charts, in the same
 *  order the charts assign palette indices (plain sort). Scalar charts use the
 *  single 'value' key; numeric frequency buckets only exist at runtime → []. */
function designTimeSeriesKeys(ind: Indicator, model: CAModel): string[] {
  if (ind.kind === 'standalone') return ['value'];
  if (ind.linkedAggregation === 'total') return ['value'];
  if (ind.dataType === 'bool') return ['false', 'true'];
  if (ind.dataType === 'tag') {
    const attr = model.attributes.find(a => a.id === ind.linkedAttributeId);
    return [...(attr?.tagOptions ?? [])].sort();
  }
  return [];
}

const CHART_COLOR_TOKENS = [
  '--chart-color-1', '--chart-color-2', '--chart-color-3', '--chart-color-4',
  '--chart-color-5', '--chart-color-6', '--chart-color-7', '--chart-color-8',
  '--chart-color-9', '--chart-color-10',
] as const;

/** Normalize a CSS color token to #rrggbb for <input type="color">. */
function toHexColor(c: string | undefined, fallback: string): string {
  if (c && /^#[0-9a-f]{6}$/i.test(c.trim())) return c.trim();
  if (c && /^#[0-9a-f]{3}$/i.test(c.trim())) {
    const h = c.trim().slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  return fallback;
}

/** Editor for the model-level chart display DEFAULTS (Indicator.chartSettings):
 *  fixed Y range (blank = dynamic), tick count, per-series default colors. The
 *  simulator's gear popover layers per-user overrides on top of these. */
function ChartDefaultsEditor({ indicator, model, onChange }: {
  indicator: Indicator;
  model: CAModel;
  onChange: (next: IndicatorChartSettings | undefined) => void;
}) {
  const cs = indicator.chartSettings ?? {};
  const categories = designTimeSeriesKeys(indicator, model);
  const paletteTokens = useThemeTokens(CHART_COLOR_TOKENS);
  const palette = paletteTokens.map(c => c || '#888888');
  // Numeric frequency buckets (integer values / float value-bins) are only
  // known at runtime — colors for those are set via the simulator gear.
  const runtimeOnlySeries = indicator.kind === 'linked'
    && indicator.linkedAggregation === 'frequency'
    && (indicator.dataType === 'integer' || indicator.dataType === 'float');

  const emit = (next: IndicatorChartSettings) => {
    const empty = next.yMin === undefined && next.yMax === undefined
      && next.yTicks === undefined
      && (!next.seriesColors || Object.keys(next.seriesColors).length === 0);
    onChange(empty ? undefined : next);
  };
  const setNum = (field: 'yMin' | 'yMax' | 'yTicks') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next: IndicatorChartSettings = { ...cs, seriesColors: cs.seriesColors ? { ...cs.seriesColors } : undefined };
    if (e.target.value === '') {
      delete next[field];
    } else {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) return;
      next[field] = field === 'yTicks' ? Math.max(2, Math.min(11, Math.round(n))) : n;
    }
    emit(next);
  };
  const setSeriesColor = (cat: string, color: string | null) => {
    const colors = { ...(cs.seriesColors ?? {}) };
    if (color === null) delete colors[cat];
    else colors[cat] = color;
    emit({ ...cs, seriesColors: Object.keys(colors).length > 0 ? colors : undefined });
  };

  const numField = (label: string, field: 'yMin' | 'yMax' | 'yTicks', title: string, placeholder: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem' }} title={title}>
      <span style={{ flex: '0 0 44px', color: '#8090a0' }}>{label}</span>
      <input
        className={styles.numberInput}
        style={{ flex: 1, minWidth: 0 }}
        type="number"
        step={field === 'yTicks' ? 1 : 'any'}
        lang="en"
        min={field === 'yTicks' ? 2 : undefined}
        max={field === 'yTicks' ? 11 : undefined}
        value={cs[field] ?? ''}
        placeholder={placeholder}
        onChange={setNum(field)}
      />
    </label>
  );

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>Chart Settings</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
        {numField('Y min', 'yMin', 'Fixed Y-axis minimum — blank = dynamic (follows the data)', 'auto')}
        {numField('Y max', 'yMax', 'Fixed Y-axis maximum — blank = dynamic (follows the data)', 'auto')}
        {numField('Y ticks', 'yTicks', 'Number of Y-axis tick labels including min and max (2–11)', '2')}
        {categories.map((cat, ci) => {
          const overridden = cs.seriesColors?.[cat] !== undefined;
          return (
            <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem' }}>
              <span style={{ flex: '0 0 44px', color: '#8090a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cat}>
                {cat === 'value' ? 'line' : cat}
              </span>
              <input
                type="color"
                style={{ width: 32, height: 16, padding: 0, border: '1px solid #2a3a50', borderRadius: 3, background: 'none', cursor: 'pointer' }}
                value={toHexColor(cs.seriesColors?.[cat] ?? palette[ci % palette.length], '#888888')}
                onChange={e => setSeriesColor(cat, e.target.value)}
                title={`Default series color for "${cat}"`}
              />
              {overridden && (
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8090a0', fontSize: '0.7rem', padding: '0 2px' }}
                  onClick={() => setSeriesColor(cat, null)}
                  title="Clear (back to palette default)"
                >&times;</button>
              )}
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: '0.66rem', opacity: 0.6, marginTop: 3 }}>
        {runtimeOnlySeries
          ? 'Blank = dynamic axis. Series colors for numeric frequency buckets are set in the Simulator (bucket names depend on runtime values).'
          : 'Blank = dynamic axis. The Simulator’s per-chart gear can override these per user.'}
      </div>
    </div>
  );
}

/** Checkbox multi-select for which bool/tag frequency categories to chart.
 *  `tracked` undefined/empty = all tracked. Stores the explicit subset when
 *  partial; collapses a full or empty selection back to `undefined` (= all). */
function TrackCategoriesEditor({ categories, tracked, onChange }: {
  categories: string[];
  tracked: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const isOn = (c: string) => !tracked || tracked.length === 0 || tracked.includes(c);
  const toggle = (c: string) => {
    const checked = categories.filter(isOn);
    const next = checked.includes(c) ? checked.filter(x => x !== c) : [...checked, c];
    const ordered = categories.filter(x => next.includes(x));
    onChange(ordered.length === 0 || ordered.length === categories.length ? undefined : ordered);
  };
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>Track Categories</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
        {categories.length === 0
          ? <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>(no categories)</span>
          : categories.map(c => (
              <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input type="checkbox" checked={isOn(c)} onChange={() => toggle(c)} />
                <span>{c}</span>
              </label>
            ))}
      </div>
      <div style={{ fontSize: '0.66rem', opacity: 0.6, marginTop: 3 }}>
        Only checked categories are charted (all checked = track all).
      </div>
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

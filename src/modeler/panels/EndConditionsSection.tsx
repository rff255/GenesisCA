import { useModel } from '../../model/ModelContext';
import type { EndConditions, EndConditionOp, IndicatorEndCondition } from '../../model/types';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import { useListReorder } from './useListReorder';
import { isGraphFrequencyMetric, type GraphMetric } from '../../simulator/engine/graphMetrics';
import { CheckRow, Field, Hint } from './propertiesWidgets';
import styles from './PanelContent.module.css';

function newCondId(): string {
  return `ec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * End Conditions — the measurement layer's stop rules (a max-generation cap +
 * indicator rules). Lives in the Indicators panel under the list it references.
 * Edits `properties.endConditions` exactly as the old Properties block did.
 */
export function EndConditionsSection() {
  const { model, updateProperties, reorderEndConditions } = useModel();
  const { properties } = model;
  const ec = properties.endConditions;
  const ecEnabled = !!ec?.enabled;
  const ecReorder = useListReorder(ec?.indicatorConditions || [], reorderEndConditions);
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
  // Spatial indicators (xAxis rows/columns/layers) produce per-position-bin
  // arrays, not a scalar/category count, so they can't drive a numeric end condition.
  const isSpatialIndicator = (i: { kind: string; xAxis?: string }) =>
    i.kind === 'linked' && (i.xAxis === 'rows' || i.xAxis === 'columns' || i.xAxis === 'layers');
  const addIndicatorCondition = () => {
    const firstIndicator = (model.indicators || []).find(i => !isSpatialIndicator(i));
    if (!firstIndicator) return;
    // For linked-frequency indicators, seed a sensible default category so the
    // condition is immediately valid (not every user knows they need one).
    let category: string | undefined;
    let value = firstIndicator.defaultValue ?? '0';
    if (firstIndicator.kind === 'graph'
        && isGraphFrequencyMetric((firstIndicator.graphMetric ?? 'nodeCount') as GraphMetric)) {
      // GRA P6 — the degree histogram's categories are degrees; seed 0.
      category = '0';
      value = '0';
    } else if (firstIndicator.kind === 'linked' && firstIndicator.linkedAggregation === 'frequency') {
      const linkedAttr = (model.attributes || []).find(a => a.id === firstIndicator.linkedAttributeId);
      if (linkedAttr?.type === 'bool') category = 'true';
      else if (linkedAttr?.type === 'tag') category = linkedAttr.tagOptions?.[0] ?? '';
      else if (linkedAttr?.type === 'integer') category = '0';
      // float: leave undefined — UI disables the row
      value = '0'; // frequency count
    }
    const cond: IndicatorEndCondition = {
      id: newCondId(),
      indicatorId: firstIndicator.id,
      op: '==',
      value,
      ...(category !== undefined ? { category } : {}),
    };
    updateEndConditions({ indicatorConditions: [...(ec?.indicatorConditions || []), cond] });
  };
  const updateIndicatorCondition = (id: string, changes: Partial<IndicatorEndCondition>) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).map(c => (c.id === id ? { ...c, ...changes } : c)),
    });
  };
  const removeIndicatorCondition = (id: string) => {
    updateEndConditions({ indicatorConditions: (ec?.indicatorConditions || []).filter(c => c.id !== id) });
  };

  return (
    <div className={styles.fieldGroup}>
      <CheckRow
        checked={ecEnabled}
        onChange={v => updateEndConditions({ enabled: v })}
        label="Auto-pause on end conditions"
        title="When enabled, the simulator pauses once any condition is met — the max generation is reached, or an indicator rule matches. Stop Event nodes in the graph pause independently of this."
      />
      {ecEnabled && (
        <>
          <Field label="Max generations" title="Pause at this generation. Blank = no limit.">
            <NumberField
              className={styles.numberInput}
              min={0}
              integer
              placeholder="(no limit)"
              value={ec?.maxGenerations}
              onNumber={n => updateEndConditions({ maxGenerations: n })}
              onClear={() => updateEndConditions({ maxGenerations: undefined })}
            />
          </Field>
          <Field label="Indicator conditions" title="Pause when an indicator's value (or a category's count, for frequency indicators) satisfies the comparison.">
            {(model.indicators || []).length === 0 && (
              <Hint>Define at least one indicator to add conditions.</Hint>
            )}
            <div data-reorder-list>
            {(ec?.indicatorConditions || []).map((cond, condIdx, condArr) => {
              const ind = (model.indicators || []).find(i => i.id === cond.indicatorId);
              // GRA P6 — a frequency-shaped GRAPH metric (degree histogram) is
              // category-keyed like a linked-frequency indicator; its keys are
              // integers (degrees), so it reuses the integer widget.
              const isGraphFreq = ind?.kind === 'graph'
                && isGraphFrequencyMetric((ind.graphMetric ?? 'nodeCount') as GraphMetric);
              const isFreq = (ind?.kind === 'linked' && ind?.linkedAggregation === 'frequency') || isGraphFreq;
              const linkedAttr = isFreq && ind?.kind === 'linked'
                ? (model.attributes || []).find(a => a.id === ind.linkedAttributeId)
                : undefined;
              const freqKind = isGraphFreq ? 'integer' : isFreq ? linkedAttr?.type : undefined; // 'bool'|'tag'|'integer'|'float'
              const floatFreqDisabled = freqKind === 'float';
              const isDragging = ecReorder.dragState?.id === cond.id;
              const srcIdx = ecReorder.dragState ? condArr.findIndex(c => c.id === ecReorder.dragState!.id) : -1;
              const showBefore = ecReorder.dragState?.overIdx === condIdx && srcIdx !== condIdx && srcIdx !== condIdx - 1;
              const showAfter = ecReorder.dragState?.overIdx === condArr.length && condIdx === condArr.length - 1 && srcIdx !== condIdx;
              return (
                <div
                  key={cond.id}
                  data-reorder-row
                  className={`${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}
                >
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <select
                      className={styles.selectInput}
                      style={{ flex: 1.4 }}
                      value={cond.indicatorId}
                      onChange={e => {
                        // Clear category on indicator change — the old key may be meaningless for the new indicator.
                        updateIndicatorCondition(cond.id, { indicatorId: e.target.value, category: undefined });
                      }}
                    >
                      {(model.indicators || [])
                        .filter(i => !isSpatialIndicator(i) || i.id === cond.indicatorId)
                        .map(i => (
                          <option key={i.id} value={i.id}>{i.name}</option>
                        ))}
                    </select>
                    {/* Category widget (linked-frequency only) */}
                    {isFreq && freqKind === 'bool' && (
                      <select
                        className={styles.selectInput}
                        style={{ flex: 1 }}
                        value={cond.category ?? 'true'}
                        onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                        title="Category to monitor (count of cells with this value)"
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    )}
                    {isFreq && freqKind === 'tag' && (
                      <select
                        className={styles.selectInput}
                        style={{ flex: 1 }}
                        value={cond.category ?? (linkedAttr?.tagOptions?.[0] ?? '')}
                        onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                        title="Tag to monitor (count of cells with this tag)"
                      >
                        {(linkedAttr?.tagOptions || []).map((tag, i) => (
                          <option key={i} value={tag}>{tag}</option>
                        ))}
                      </select>
                    )}
                    {isFreq && freqKind === 'integer' && (
                      <NumberField
                        className={styles.numberInput}
                        integer
                        style={{ flex: 1 }}
                        placeholder="value"
                        value={cond.category}
                        onNumber={n => updateIndicatorCondition(cond.id, { category: String(n) })}
                        onClear={() => updateIndicatorCondition(cond.id, { category: undefined })}
                        title="Integer value to monitor (count of cells with this value)"
                      />
                    )}
                    <select
                      className={styles.selectInput}
                      style={{ width: 52 }}
                      value={cond.op}
                      disabled={floatFreqDisabled}
                      onChange={e => updateIndicatorCondition(cond.id, { op: e.target.value as EndConditionOp })}
                    >
                      <option value="==">==</option>
                      <option value="!=">!=</option>
                      <option value=">">&gt;</option>
                      <option value="<">&lt;</option>
                      <option value=">=">&ge;</option>
                      <option value="<=">&le;</option>
                    </select>
                    {/* Value widget: scalar branches when NOT a frequency indicator;
                        count (number) when frequency (except float-binned, which is disabled) */}
                    {!isFreq && ind?.dataType === 'bool' ? (
                      <select
                        className={styles.selectInput}
                        style={{ flex: 1 }}
                        value={cond.value === '1' || cond.value === 'true' ? 'true' : 'false'}
                        onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                      >
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </select>
                    ) : !isFreq && ind?.dataType === 'tag' ? (
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
                      <NumberField
                        className={styles.numberInput}
                        integer={isFreq || ind?.dataType === 'integer'}
                        style={{ flex: 1 }}
                        value={cond.value}
                        disabled={floatFreqDisabled}
                        placeholder={isFreq ? 'count' : undefined}
                        onNumber={n => updateIndicatorCondition(cond.id, { value: String(n) })}
                      />
                    )}
                    <button
                      className={styles.dragHandle}
                      title="Drag to reorder"
                      onPointerDown={ecReorder.startDrag(cond.id)}
                      onClick={e => e.stopPropagation()}
                    >⋮⋮</button>
                    <button
                      className={styles.deleteButton}
                      style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                      onClick={() => removeIndicatorCondition(cond.id)}
                      title="Remove condition"
                    >
                      &times;
                    </button>
                  </div>
                  {floatFreqDisabled && (
                    <Hint warn>
                      Decimal-binned frequency categories depend on the runtime range. Change this indicator&apos;s aggregation to Total, or pick a different indicator.
                    </Hint>
                  )}
                </div>
              );
            })}
            </div>
            <button
              className={styles.addButton}
              style={{ fontSize: '0.72rem', padding: '2px 8px', marginTop: 4 }}
              disabled={(model.indicators || []).length === 0}
              onClick={addIndicatorCondition}
            >
              + Add Indicator Condition
            </button>
          </Field>
        </>
      )}
    </div>
  );
}

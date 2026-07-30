import { useState, useCallback, useEffect, useRef } from 'react';
import type { Indicator, IndicatorChartSettings } from '../model/types';
import { useThemeTokens } from '../styles/useThemeTokens';
import { IndicatorSparkline } from './IndicatorSparkline';
import { IndicatorMultiLineChart } from './IndicatorMultiLineChart';
import { IndicatorStackedAreaChart } from './IndicatorStackedAreaChart';
import { IndicatorSpatialChart, compareSeriesKeys } from './IndicatorSpatialChart';
import { SCALAR_SERIES_KEY, mergeChartSettings, historyWindow, sliceWindow, INDICATOR_HISTORY_HARD_CAP } from './indicatorChartSettings';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { isGraphFrequencyMetric, GRAPH_METRIC_INFO, type GraphMetric } from './engine/graphMetrics';
import styles from './IndicatorDisplay.module.css';

export type IndicatorVizMode = 'bars' | 'multiline' | 'stacked';

interface Props {
  indicators: Indicator[];
  /** number → scalar; Record<cat,number> → frequency map; Record<key,number[]>
   *  → spatial (per-position-bin series, xAxis rows/columns). */
  values: Record<string, number | Record<string, number> | Record<string, number[]>>;
  history: Record<string, number[] | Record<string, number[]>>;
  generation: number;
  /** Live grid dimensions — used to label a spatial chart's X-axis with real
   *  row/column positions. */
  gridWidth: number;
  gridHeight: number;
  /** 3D Grid CA: layer count, for the 'layers' spatial axis. Absent → 1. */
  gridDepth?: number;
  vizModes: Record<string, IndicatorVizMode>;
  /** Per-indicator set of legend categories the user has hidden (Lines/Stack). */
  hiddenCategories: Record<string, Set<string>>;
  /** Simulator-side chart-settings overrides (gear popover) — a field-level
   *  layer over each Indicator.chartSettings default. */
  chartOverrides: Record<string, IndicatorChartSettings>;
  onToggleWatch: (id: string, watched: boolean) => void;
  onChartToggle: (id: string, expanded: boolean) => void;
  onCycleVizMode: (id: string) => void;
  /** Set one indicator's viz mode directly (the spatial Lines ⇄ Bars toggle —
   *  a 2-state flip, so cycling through the 3 freq modes doesn't fit). */
  onSetVizMode: (id: string, mode: IndicatorVizMode) => void;
  /** Toggle one category's visibility for a frequency indicator's chart. */
  onToggleCategory: (id: string, category: string) => void;
  /** Replace one indicator's override entry (null clears it entirely). */
  onChangeChartOverrides: (id: string, next: IndicatorChartSettings | null) => void;
  /** Wipe the accumulated time-series history for one indicator's chart so the
   *  user can start monitoring afresh (e.g. after a reset). */
  onClearHistory: (id: string) => void;
  /** Per-indicator design-time series-key order (designTimeSeriesKeys) —
   *  keeps palette indices stable under Track Categories filtering. */
  categoryOrders: Record<string, string[]>;
}

const CHART_COLOR_TOKENS = [
  '--chart-color-1', '--chart-color-2', '--chart-color-3', '--chart-color-4',
  '--chart-color-5', '--chart-color-6', '--chart-color-7', '--chart-color-8',
  '--chart-color-9', '--chart-color-10',
] as const;

/** Series keys an indicator's charts can color, in the same order the charts
 *  assign palette indices (spatial → compareSeriesKeys; freq → plain sort;
 *  scalar → the single "value" key). Runtime-derived: keys come from the
 *  current value/history, with a static true/false fallback for bools. */
function seriesKeysOf(
  ind: Indicator,
  val: number | Record<string, number> | Record<string, number[]> | undefined,
  hist: number[] | Record<string, number[]> | undefined,
): string[] {
  if (typeof val === 'number' || ind.kind === 'standalone') return [SCALAR_SERIES_KEY];
  // GRA P6 — a graph SCALAR metric before its first value arrives.
  if (ind.kind === 'graph' && !isGraphFrequencyMetric((ind.graphMetric ?? 'nodeCount') as GraphMetric)) {
    return [SCALAR_SERIES_KEY];
  }
  const isSpatial = ind.kind === 'linked' && (ind.xAxis === 'rows' || ind.xAxis === 'columns' || ind.xAxis === 'layers');
  const keys = new Set<string>();
  if (val && typeof val === 'object') for (const k of Object.keys(val)) keys.add(k);
  if (hist && !Array.isArray(hist)) for (const k of Object.keys(hist)) keys.add(k);
  if (keys.size === 0) {
    if (ind.linkedAggregation === 'total') return [SCALAR_SERIES_KEY];
    if (ind.dataType === 'bool') return ['false', 'true'];
    return [];
  }
  return [...keys].sort(isSpatial ? compareSeriesKeys : undefined);
}

/** Normalize a CSS color token to #rrggbb for <input type="color">. */
function toHexColor(c: string | undefined, fallback: string): string {
  if (c && /^#[0-9a-f]{6}$/i.test(c.trim())) return c.trim();
  if (c && /^#[0-9a-f]{3}$/i.test(c.trim())) {
    const h = c.trim().slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  return fallback;
}

/** Gear popover: edits the OVERRIDE layer (number fields blank = inherit the
 *  model default, whose value shows as the placeholder; 'auto' = dynamic). */
function ChartSettingsPopover({ ind, override, categories, palette, categoryOrder, onChange, onClose }: {
  ind: Indicator;
  override: IndicatorChartSettings | undefined;
  categories: string[];
  palette: string[];
  /** Design-time series order — palette default swatches use the category's
   *  stable index here (matches the charts), runtime index as fallback. */
  categoryOrder?: string[];
  onChange: (next: IndicatorChartSettings | null) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const defaults = ind.chartSettings;

  // Outside-press dismiss (capture phase so panel scrolling etc. still work).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  const ov: IndicatorChartSettings = override ?? {};
  const emit = (next: IndicatorChartSettings) => {
    const empty = next.yMin === undefined && next.yMax === undefined
      && next.yTicks === undefined && next.window === undefined
      && (!next.seriesColors || Object.keys(next.seriesColors).length === 0);
    onChange(empty ? null : next);
  };
  const setNum = (field: 'yMin' | 'yMax' | 'yTicks' | 'window') => (n: number) => {
    const next = { ...ov, seriesColors: ov.seriesColors ? { ...ov.seriesColors } : undefined };
    next[field] = n;
    emit(next);
  };
  const clearNum = (field: 'yMin' | 'yMax' | 'yTicks' | 'window') => () => {
    const next = { ...ov, seriesColors: ov.seriesColors ? { ...ov.seriesColors } : undefined };
    delete next[field];
    emit(next);
  };
  const setSeriesColor = (cat: string, color: string | null) => {
    const colors = { ...(ov.seriesColors ?? {}) };
    if (color === null) delete colors[cat];
    else colors[cat] = color;
    emit({ ...ov, seriesColors: Object.keys(colors).length > 0 ? colors : undefined });
  };

  const numPlaceholder = (field: 'yMin' | 'yMax') =>
    defaults?.[field] !== undefined ? String(defaults[field]) : 'auto';

  return (
    <div ref={popRef} className={styles.settingsPop}>
      <div className={styles.settingsTitleRow}>
        <span className={styles.settingsTitle}>Chart settings</span>
        <button className={styles.settingsClose} onClick={onClose} title="Close">&times;</button>
      </div>
      <div className={styles.settingsRow}>
        <span className={styles.settingsLabel}>Y min</span>
        <NumberField
          className={styles.settingsInput}
          value={ov.yMin} placeholder={numPlaceholder('yMin')}
          onNumber={setNum('yMin')} onClear={clearNum('yMin')}
          title="Fixed Y-axis minimum — blank = dynamic (follows the data)"
        />
      </div>
      <div className={styles.settingsRow}>
        <span className={styles.settingsLabel}>Y max</span>
        <NumberField
          className={styles.settingsInput}
          value={ov.yMax} placeholder={numPlaceholder('yMax')}
          onNumber={setNum('yMax')} onClear={clearNum('yMax')}
          title="Fixed Y-axis maximum — blank = dynamic (follows the data)"
        />
      </div>
      <div className={styles.settingsRow}>
        <span className={styles.settingsLabel}>Y ticks</span>
        <NumberField
          className={styles.settingsInput} min={2} max={11} integer
          value={ov.yTicks}
          placeholder={defaults?.yTicks !== undefined ? String(defaults.yTicks) : '2'}
          onNumber={setNum('yTicks')} onClear={clearNum('yTicks')}
          title="Number of Y-axis tick labels including min and max (2–11)"
        />
      </div>
      {!(ind.kind === 'linked' && (ind.xAxis === 'rows' || ind.xAxis === 'columns' || ind.xAxis === 'layers')) && (
        <div className={styles.settingsRow}>
          <span className={styles.settingsLabel}>Window</span>
          <NumberField
            className={styles.settingsInput} min={2} max={INDICATOR_HISTORY_HARD_CAP} integer
            value={ov.window}
            placeholder={defaults?.window !== undefined ? String(defaults.window) : 'all'}
            onNumber={setNum('window')} onClear={clearNum('window')}
            title={`X-axis window — number of most-recent generations to show. Blank = show all stored history (always bounded: history is capped at ${INDICATOR_HISTORY_HARD_CAP} samples per series).`}
          />
        </div>
      )}
      {categories.length > 0 && (
        <>
          <div className={styles.settingsSection}>Series colors</div>
          {categories.map((cat, ci) => {
            const stable = categoryOrder ? categoryOrder.indexOf(cat) : -1;
            const pi = stable >= 0 ? stable : ci;
            const overridden = ov.seriesColors?.[cat] !== undefined;
            const effective = ov.seriesColors?.[cat]
              ?? defaults?.seriesColors?.[cat]
              ?? palette[pi % palette.length]!;
            return (
              <div key={cat} className={styles.settingsRow}>
                <span className={styles.settingsLabel} title={cat}>
                  {cat === SCALAR_SERIES_KEY ? 'line' : cat}
                </span>
                <input
                  type="color"
                  className={styles.settingsColor}
                  value={toHexColor(effective, '#888888')}
                  onChange={e => setSeriesColor(cat, e.target.value)}
                  title={`Series color for "${cat}"`}
                />
                {overridden && (
                  <button
                    className={styles.settingsClose}
                    onClick={() => setSeriesColor(cat, null)}
                    title="Clear override (back to default)"
                  >&times;</button>
                )}
              </div>
            );
          })}
        </>
      )}
      <button
        className={styles.settingsReset}
        onClick={() => onChange(null)}
        title="Remove every simulator-side override for this chart"
      >
        Reset to model defaults
      </button>
    </div>
  );
}

function formatValue(val: number, ind: Indicator): string {
  if (ind.dataType === 'bool') return val ? 'true' : 'false';
  if (ind.dataType === 'tag' && ind.tagOptions) {
    return ind.tagOptions[val] ?? `tag_${val}`;
  }
  if (ind.dataType === 'float') return val.toFixed(2);
  return String(val);
}

export function IndicatorDisplay({ indicators, values, history, generation, gridWidth, gridHeight, gridDepth = 1, vizModes, hiddenCategories, chartOverrides, onToggleWatch, onChartToggle, onCycleVizMode, onSetVizMode, onToggleCategory, onChangeChartOverrides, onClearHistory, categoryOrders }: Props) {
  // Track *collapsed* IDs — everything is expanded by default
  const [collapsedCharts, setCollapsedCharts] = useState<Set<string>>(new Set());
  // Per-indicator custom content height (drag-to-resize)
  const [heights, setHeights] = useState<Record<string, number>>({});
  const resizing = useRef<{ id: string; startY: number; startH: number } | null>(null);
  // Which indicator's chart-settings gear popover is open (one at a time).
  const [gearOpenId, setGearOpenId] = useState<string | null>(null);
  const paletteTokens = useThemeTokens(CHART_COLOR_TOKENS);
  const palette = paletteTokens.map(c => c || '#888888');

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const { id, startY, startH } = resizing.current;
      const delta = e.clientY - startY;
      const newH = Math.max(30, startH + delta);
      setHeights(prev => ({ ...prev, [id]: newH }));
    };
    const onUp = () => { resizing.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Notify parent of all initially-expanded indicators (for history collection).
  // Do this synchronously during render (via a ref-compare) so the parent's chartExpandedRef
  // is populated before the first worker step — otherwise sparklines start blank on mount.
  // Also reset collapsedCharts when the indicator set changes (e.g., loading a new project)
  // so charts default to expanded for the new model.
  const indicatorIds = indicators.map(i => i.id).join(',');
  const lastNotifiedIds = useRef('');
  if (lastNotifiedIds.current !== indicatorIds) {
    lastNotifiedIds.current = indicatorIds;
    if (collapsedCharts.size > 0) setCollapsedCharts(new Set());
    for (const ind of indicators) {
      onChartToggle(ind.id, true);
    }
  }

  const toggleChart = useCallback((id: string) => {
    setCollapsedCharts(prev => {
      const next = new Set(prev);
      const wasCollapsed = next.has(id);
      if (wasCollapsed) next.delete(id); else next.add(id);
      onChartToggle(id, wasCollapsed); // wasCollapsed → now expanded
      return next;
    });
  }, [onChartToggle]);

  if (indicators.length === 0) return null;

  return (
    <div className={styles.container}>
      {indicators.map(ind => {
        const val = values[ind.id];
        const isWatched = ind.watched;
        const isStandalone = ind.kind === 'standalone';
        const isExpanded = !collapsedCharts.has(ind.id);
        // Spatial (xAxis rows/columns) sends Record<seriesKey, number[]> — also
        // typeof 'object', so it must be split out from the frequency branch.
        const isSpatial = ind.kind === 'linked' && (ind.xAxis === 'rows' || ind.xAxis === 'columns' || ind.xAxis === 'layers');
        const isScalar = val !== undefined && typeof val === 'number';
        const isFreq = val !== undefined && typeof val === 'object' && !isSpatial;
        // DEFINITION-based shape flags (independent of whether a value has
        // arrived yet) — drive the header CONTROL visibility so the viz-mode /
        // clear buttons are discoverable from load, not only after the first
        // step delivers a value. The val-shape flags above keep driving the
        // chart rendering itself.
        // GRA P6 — a graph indicator's shape comes from its metric: the degree
        // histogram is frequency-shaped (bars / lines / stack), everything else
        // is a scalar sparkline. Definition-based like the linked flags, so the
        // header controls are discoverable before the first value arrives.
        const isGraphFreq = ind.kind === 'graph'
          && isGraphFrequencyMetric((ind.graphMetric ?? 'nodeCount') as GraphMetric);
        const isFreqDef = !isSpatial
          && ((ind.kind === 'linked' && ind.linkedAggregation === 'frequency') || isGraphFreq);
        const isScalarDef = !isSpatial && (ind.kind === 'standalone'
          || (ind.kind === 'linked' && ind.linkedAggregation !== 'frequency')
          || (ind.kind === 'graph' && !isGraphFreq));
        // Effective chart settings: model defaults ⊕ simulator overrides.
        const chartFx = mergeChartSettings(ind.chartSettings, chartOverrides[ind.id]);
        const hasAnyChartSetting = ind.chartSettings !== undefined || chartOverrides[ind.id] !== undefined;
        // Time-series X-axis window (most-recent N generations); undefined = all.
        const win = historyWindow(chartFx);

        return (
          <div key={ind.id} className={styles.indicator}>
            <div className={styles.header}>
              {!isStandalone && (
                <button
                  className={`${styles.eyeBtn} ${isWatched ? styles.eyeActive : ''}`}
                  onClick={() => onToggleWatch(ind.id, !isWatched)}
                  title={isWatched ? 'Unwatch (stop computing)' : 'Watch (start computing)'}
                >
                  {isWatched ? '\u{1F441}' : '\u25CB'}
                </button>
              )}
              {isWatched && (
                <button
                  className={`${styles.chartBtn} ${isExpanded ? styles.chartBtnActive : ''}`}
                  onClick={() => toggleChart(ind.id)}
                  title={isExpanded ? 'Hide chart' : 'Show chart'}
                >
                  {isExpanded ? '\u25B2' : '\u25BC'}
                </button>
              )}
              {isWatched && (isFreq || isFreqDef) && isExpanded && (() => {
                const mode = vizModes[ind.id] ?? 'bars';
                const label = mode === 'bars' ? 'Bars' : mode === 'multiline' ? 'Lines' : 'Stack';
                return (
                  <button
                    className={styles.chartBtn}
                    onClick={() => onCycleVizMode(ind.id)}
                    title={`Viz: ${label} \u2014 click to cycle (Bars \u2192 Lines \u2192 Stack)`}
                    style={{ fontSize: '0.7rem', minWidth: 40 }}
                  >
                    {label}
                  </button>
                );
              })()}
              {isWatched && isSpatial && isExpanded && (() => {
                // Spatial charts have their own 2-state style toggle (curves or a
                // per-bin histogram). Stored in the same persisted vizModes slot:
                // 'bars' = bars, anything else = lines.
                const sMode = vizModes[ind.id] === 'bars' ? 'bars' : 'lines';
                const label = sMode === 'bars' ? 'Bars' : 'Lines';
                return (
                  <button
                    className={styles.chartBtn}
                    onClick={() => onSetVizMode(ind.id, sMode === 'bars' ? 'multiline' : 'bars')}
                    title={`Spatial chart style: ${label} \u2014 click to toggle (Lines \u21c4 Bars)`}
                    style={{ fontSize: '0.7rem', minWidth: 40 }}
                  >
                    {label}
                  </button>
                );
              })()}
              {isWatched && isExpanded && (
                <button
                  className={`${styles.chartBtn} ${gearOpenId === ind.id || hasAnyChartSetting ? styles.chartBtnActive : ''}`}
                  onClick={() => setGearOpenId(g => (g === ind.id ? null : ind.id))}
                  title="Chart settings (axis range, ticks, window, series colors)"
                >
                  {'\u2699'}
                </button>
              )}
              {isWatched && isExpanded && (isScalar || isFreq || isScalarDef || isFreqDef) && (
                <button
                  className={styles.chartBtn}
                  onClick={() => onClearHistory(ind.id)}
                  title="Clear chart history \u2014 start monitoring this indicator afresh"
                >
                  {'\u232b'}
                </button>
              )}
              {isWatched && isExpanded && isSpatial && (
                <button
                  className={styles.chartBtn}
                  disabled
                  style={{ opacity: 0.35, cursor: 'default' }}
                  title="Nothing to clear \u2014 a spatial chart redraws from the CURRENT generation each step (it keeps no history)"
                >
                  {'\u232b'}
                </button>
              )}
              <span className={styles.name}>{ind.name}</span>
              <span
                className={styles.badge}
                title={ind.kind === 'graph'
                  ? GRAPH_METRIC_INFO[(ind.graphMetric ?? 'nodeCount') as GraphMetric]?.label ?? 'Graph metric'
                  : undefined}
              >
                {ind.kind === 'standalone' ? 'S' : ind.kind === 'graph' ? 'G' : 'L'}
              </span>
            </div>

            {gearOpenId === ind.id && (
              <ChartSettingsPopover
                ind={ind}
                override={chartOverrides[ind.id]}
                categories={seriesKeysOf(ind, val, history[ind.id])}
                palette={palette}
                categoryOrder={categoryOrders[ind.id]}
                onChange={next => onChangeChartOverrides(ind.id, next)}
                onClose={() => setGearOpenId(null)}
              />
            )}

            {isWatched && isScalar && (
              <div className={styles.scalarValue}>{formatValue(val as number, ind)}</div>
            )}

            {isWatched && isScalar && isExpanded && (() => {
              const h = heights[ind.id] ?? 60;
              const hist = history[ind.id];
              const scalarHist = Array.isArray(hist) ? hist : [];
              return (
                <div className={styles.sparklineWrap} style={{ height: h }}>
                  <IndicatorSparkline
                    data={sliceWindow(scalarHist, win)}
                    generation={generation}
                    height={h}
                    settings={chartFx}
                  />
                </div>
              );
            })()}

            {isWatched && isFreq && !isExpanded && (
              <div className={styles.freqTable}>
                {Object.entries(val as Record<string, number>).map(([k, count]) => (
                  <div key={k} className={styles.freqRow}>
                    <span className={styles.freqKey} title={k}>{k}</span>
                    <span className={styles.freqCount}>{count}</span>
                  </div>
                ))}
              </div>
            )}

            {isWatched && isFreq && isExpanded && (() => {
              const mode = vizModes[ind.id] ?? 'bars';
              const h = heights[ind.id] ?? 160;
              const hist = history[ind.id];
              const rawCatHist = (hist && !Array.isArray(hist)) ? (hist as Record<string, number[]>) : {};
              const catHist = win === undefined
                ? rawCatHist
                : Object.fromEntries(Object.entries(rawCatHist).map(([k, arr]) => [k, sliceWindow(arr, win)]));

              if (mode === 'multiline') {
                return (
                  <div className={styles.sparklineWrap} style={{ height: h }}>
                    <IndicatorMultiLineChart
                      data={catHist} generation={generation} height={h}
                      hidden={hiddenCategories[ind.id]}
                      onToggleCategory={cat => onToggleCategory(ind.id, cat)}
                      settings={chartFx}
                      categoryOrder={categoryOrders[ind.id]}
                    />
                  </div>
                );
              }
              if (mode === 'stacked') {
                return (
                  <div className={styles.sparklineWrap} style={{ height: h }}>
                    <IndicatorStackedAreaChart
                      data={catHist} generation={generation} height={h}
                      hidden={hiddenCategories[ind.id]}
                      onToggleCategory={cat => onToggleCategory(ind.id, cat)}
                      settings={chartFx}
                      categoryOrder={categoryOrders[ind.id]}
                    />
                  </div>
                );
              }
              // bars (default)
              const freqMap = val as Record<string, number>;
              const entries = Object.entries(freqMap);
              const maxCount = Math.max(...entries.map(([, c]) => c), 1);
              return (
                <div className={styles.freqTable} style={{ maxHeight: h, height: h }}>
                  {entries.map(([k, count]) => (
                    <div key={k} className={styles.freqBarRow}>
                      <span className={styles.freqKey} title={k}>{k}</span>
                      <div className={styles.freqBarTrack}>
                        <div
                          className={styles.freqBar}
                          style={{ width: `${(count / maxCount) * 100}%` }}
                        />
                      </div>
                      <span className={styles.freqCount}>{count}</span>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Spatial (chromatogram): live position histogram. One curve per
                series over the chosen grid axis; no time-history, no viz cycle. */}
            {isWatched && isSpatial && !isExpanded && val !== undefined && (
              <div className={styles.freqTable}>
                {Object.entries(val as Record<string, number[]>).map(([k, arr]) => {
                  let sum = 0;
                  for (const x of arr) sum += x;
                  return (
                    <div key={k} className={styles.freqRow}>
                      <span className={styles.freqKey} title={k}>{k}</span>
                      <span className={styles.freqCount}>{sum}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {isWatched && isSpatial && isExpanded && val !== undefined && (() => {
              const h = heights[ind.id] ?? 160;
              const spatialData = typeof val === 'object' ? (val as Record<string, number[]>) : {};
              const axis = ind.xAxis === 'columns' ? 'columns' : ind.xAxis === 'layers' ? 'layers' : 'rows';
              const axisLength = axis === 'rows' ? gridHeight : axis === 'layers' ? gridDepth : gridWidth;
              return (
                <div className={styles.sparklineWrap} style={{ height: h }}>
                  <IndicatorSpatialChart
                    data={spatialData} axis={axis} axisLength={axisLength} height={h}
                    hidden={hiddenCategories[ind.id]}
                    onToggleCategory={cat => onToggleCategory(ind.id, cat)}
                    settings={chartFx}
                    categoryOrder={categoryOrders[ind.id]}
                    mode={vizModes[ind.id] === 'bars' ? 'bars' : 'lines'}
                  />
                </div>
              );
            })()}

            {isWatched && isExpanded && val !== undefined && (
              <div
                className={styles.resizeHandle}
                onMouseDown={e => {
                  e.preventDefault();
                  const currentH = heights[ind.id] ?? (isScalar ? 60 : 160);
                  resizing.current = { id: ind.id, startY: e.clientY, startH: currentH };
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

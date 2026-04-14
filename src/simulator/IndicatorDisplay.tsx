import { useState, useCallback, useEffect, useRef } from 'react';
import type { Indicator } from '../model/types';
import { IndicatorSparkline } from './IndicatorSparkline';
import styles from './IndicatorDisplay.module.css';

interface Props {
  indicators: Indicator[];
  values: Record<string, number | Record<string, number>>;
  history: Record<string, number[]>;
  generation: number;
  onToggleWatch: (id: string, watched: boolean) => void;
  onChartToggle: (id: string, expanded: boolean) => void;
}

function formatValue(val: number, ind: Indicator): string {
  if (ind.dataType === 'bool') return val ? 'true' : 'false';
  if (ind.dataType === 'tag' && ind.tagOptions) {
    return ind.tagOptions[val] ?? `tag_${val}`;
  }
  if (ind.dataType === 'float') return val.toFixed(2);
  return String(val);
}

export function IndicatorDisplay({ indicators, values, history, generation, onToggleWatch, onChartToggle }: Props) {
  // Track *collapsed* IDs — everything is expanded by default
  const [collapsedCharts, setCollapsedCharts] = useState<Set<string>>(new Set());
  // Per-indicator custom content height (drag-to-resize)
  const [heights, setHeights] = useState<Record<string, number>>({});
  const resizing = useRef<{ id: string; startY: number; startH: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const delta = e.clientY - resizing.current.startY;
      const newH = Math.max(30, resizing.current.startH + delta);
      setHeights(prev => ({ ...prev, [resizing.current!.id]: newH }));
    };
    const onUp = () => { resizing.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Notify parent of all initially-expanded indicators (for history collection)
  const indicatorIds = indicators.map(i => i.id).join(',');
  useEffect(() => {
    for (const ind of indicators) {
      if (!collapsedCharts.has(ind.id)) onChartToggle(ind.id, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorIds]);

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
        const isScalar = val !== undefined && typeof val === 'number';
        const isFreq = val !== undefined && typeof val === 'object';

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
              {isWatched && val !== undefined && (
                <button
                  className={`${styles.chartBtn} ${isExpanded ? styles.chartBtnActive : ''}`}
                  onClick={() => toggleChart(ind.id)}
                  title={isExpanded ? 'Hide chart' : 'Show chart'}
                >
                  {isExpanded ? '\u25B2' : '\u25BC'}
                </button>
              )}
              <span className={styles.name}>{ind.name}</span>
              <span className={styles.badge}>
                {ind.kind === 'standalone' ? 'S' : 'L'}
              </span>
            </div>

            {isWatched && isScalar && (
              <div className={styles.scalarValue}>{formatValue(val as number, ind)}</div>
            )}

            {isWatched && isScalar && isExpanded && (() => {
              const h = heights[ind.id] ?? 60;
              return (
                <div className={styles.sparklineWrap} style={{ height: h }}>
                  <IndicatorSparkline
                    data={history[ind.id] || []}
                    generation={generation}
                    height={h}
                  />
                </div>
              );
            })()}

            {isWatched && isFreq && !isExpanded && (
              <div className={styles.freqTable}>
                {Object.entries(val as Record<string, number>).map(([k, count]) => (
                  <div key={k} className={styles.freqRow}>
                    <span className={styles.freqKey}>{k}</span>
                    <span className={styles.freqCount}>{count}</span>
                  </div>
                ))}
              </div>
            )}

            {isWatched && isFreq && isExpanded && (() => {
              const freqMap = val as Record<string, number>;
              const entries = Object.entries(freqMap);
              const maxCount = Math.max(...entries.map(([, c]) => c), 1);
              const h = heights[ind.id];
              return (
                <div className={styles.freqTable} style={h != null ? { maxHeight: h, height: h } : undefined}>
                  {entries.map(([k, count]) => (
                    <div key={k} className={styles.freqBarRow}>
                      <span className={styles.freqKey}>{k}</span>
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

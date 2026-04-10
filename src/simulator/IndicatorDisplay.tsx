import type { Indicator } from '../model/types';
import styles from './IndicatorDisplay.module.css';

interface Props {
  indicators: Indicator[];
  values: Record<string, number | Record<string, number>>;
  onToggleWatch: (id: string, watched: boolean) => void;
}

function formatValue(val: number, ind: Indicator): string {
  if (ind.dataType === 'bool') return val ? 'true' : 'false';
  if (ind.dataType === 'tag' && ind.tagOptions) {
    return ind.tagOptions[val] ?? `tag_${val}`;
  }
  if (ind.dataType === 'float') return val.toFixed(2);
  return String(val);
}

export function IndicatorDisplay({ indicators, values, onToggleWatch }: Props) {
  if (indicators.length === 0) return null;

  return (
    <div className={styles.container}>
      {indicators.map(ind => {
        const val = values[ind.id];
        const isWatched = ind.watched;

        const isStandalone = ind.kind === 'standalone';

        return (
          <div key={ind.id} className={styles.indicator}>
            <div className={styles.header}>
              <button
                className={`${styles.eyeBtn} ${isWatched ? styles.eyeActive : ''} ${isStandalone ? styles.eyeDisabled : ''}`}
                onClick={isStandalone ? undefined : () => onToggleWatch(ind.id, !isWatched)}
                title={isStandalone ? 'Always active (computed by update graph)' : isWatched ? 'Unwatch (stop computing)' : 'Watch (start computing)'}
                disabled={isStandalone}
              >
                {isWatched ? '\u{1F441}' : '\u25CB'}
              </button>
              <span className={styles.name}>{ind.name}</span>
              <span className={styles.badge}>
                {ind.kind === 'standalone' ? 'S' : 'L'}
              </span>
            </div>

            {isWatched && val !== undefined && (
              typeof val === 'number' ? (
                <div className={styles.scalarValue}>{formatValue(val, ind)}</div>
              ) : (
                <div className={styles.freqTable}>
                  {Object.entries(val).map(([k, count]) => (
                    <div key={k} className={styles.freqRow}>
                      <span className={styles.freqKey}>{k}</span>
                      <span className={styles.freqCount}>{count}</span>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

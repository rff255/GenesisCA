import { useSyncExternalStore } from 'react';
import { subscribeBusy, getBusySnapshot, type BusySnapshot } from './busyState';
import styles from './BusyOverlay.module.css';

/** Subscribe to the busy store. Returns the operation to display, or null. */
export function useBusy(): BusySnapshot | null {
  return useSyncExternalStore(subscribeBusy, getBusySnapshot, getBusySnapshot);
}

/**
 * The app's single busy/progress indicator — see `busyState.ts` for the store,
 * the overlap policy and the paint-honesty rule that makes any of this mean
 * something.
 *
 * Mounted ONCE, in `App`. Everything else just calls `beginBusy()`.
 */
export function BusyOverlay() {
  const busy = useBusy();
  if (!busy) return null;
  const pct = busy.fraction === null ? null : Math.round(busy.fraction * 100);
  return (
    <div
      className={styles.busy}
      data-sim-overlay
      data-busy-label={busy.label}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-valuenow={pct ?? undefined}
      aria-valuemin={pct === null ? undefined : 0}
      aria-valuemax={pct === null ? undefined : 100}
    >
      <div className={styles.row}>
        <span className={styles.label}>{busy.label}</span>
        {busy.detail && <span className={styles.detail}>{busy.detail}</span>}
        {busy.detail === null && pct !== null && <span className={styles.detail}>{pct}%</span>}
      </div>
      <div className={styles.track}>
        {pct === null
          ? <div className={styles.shuttle} />
          : <div className={styles.fill} data-busy-fill style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}

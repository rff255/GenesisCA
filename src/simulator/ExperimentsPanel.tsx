/**
 * Experiments panel — the simulator UI for the Overseer (experiment
 * orchestration) graph. Rendered ONLY when `model.overseerConfig?.enabled`
 * (with the feature off there is no trace of it in the simulator).
 *
 * Pure view over the OverseerRuntime's Journal + Series stores (the parent
 * bumps `version` on every runtime update). Run/Abort + CSV/JSON export.
 */
import { useEffect, useRef } from 'react';
import styles from './SimulatorView.module.css';
import type { OverseerRuntime } from './engine/overseerRuntime';

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return n.toExponential(3);
  return String(Math.round(n * 1000) / 1000);
}

function download(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export interface ExperimentsPanelProps {
  runtime: OverseerRuntime | null;
  running: boolean;
  /** Bumped by the runtime's onUpdate — forces a re-render of the stores. */
  version: number;
  /** Compile error of the overseer graph (null = compiles or no graph). */
  compileError: string | null;
  /** True when the Overseer graph has an Experiment root to run. */
  hasExperiment: boolean;
  modelName: string;
  onRun: () => void;
  onAbort: () => void;
}

const KIND_COLOR: Record<string, string> = {
  text: 'inherit',
  milestone: 'var(--color-accent, #e8a13a)',
  warn: '#e0a04d',
  error: '#e05d5d',
};

export function ExperimentsPanel(props: ExperimentsPanelProps) {
  const { runtime, running, compileError, hasExperiment, modelName, onRun, onAbort } = props;
  const journalRef = useRef<HTMLDivElement | null>(null);

  // Autoscroll the journal to the newest entry on every update.
  useEffect(() => {
    const el = journalRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.version, runtime?.journal.length]);

  const seriesEntries = runtime ? [...runtime.series.entries()] : [];
  const journal = runtime?.journal ?? [];
  const shownJournal = journal.length > 200 ? journal.slice(journal.length - 200) : journal;
  const fname = (modelName || 'experiment').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'experiment';

  return (
    <div className={styles.rightPanelSection} data-sim-overlay>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>Experiments</span>
      </div>
      <div className={styles.rightPanelSectionBody} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.7rem' }}>
        {!hasExperiment && !compileError && (
          <div style={{ color: '#888' }}>
            Add an <strong>Experiment</strong> node to the Overseer graph (Modeler → the Overseer tab)
            and chain the protocol from its DO port — e.g. Loop → Set Random Seed → Reset Board →
            Run Generations → Collect Sample.
          </div>
        )}
        {compileError && (
          <div style={{ color: '#e05d5d' }}>{compileError}</div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className={styles.controlButton}
            style={{ flex: 1, fontWeight: 600 }}
            disabled={running || !hasExperiment || !!compileError}
            onClick={onRun}
            title={hasExperiment ? 'Run the Overseer experiment' : 'The Overseer graph has no Experiment root yet.'}
          >
            ▶ Run Experiment
          </button>
          <button
            className={styles.controlButton}
            style={{ flex: 1, color: running ? '#e05d5d' : undefined }}
            disabled={!running}
            onClick={onAbort}
          >
            ■ Abort
          </button>
        </div>
        {(running || runtime) && (
          <div style={{ color: '#888' }}>
            {running ? '● running — ' : runtime?.outcome ? `${runtime.outcome} — ` : ''}
            {runtime ? `${runtime.resets} run(s) · ${runtime.statusLine || 'idle'} · ${Math.round((runtime.elapsedMs() / 1000) * 10) / 10}s` : ''}
          </div>
        )}

        {journal.length > 0 && (
          <>
            <div style={{ color: '#888', fontWeight: 600, marginTop: 2 }}>Journal</div>
            <div
              ref={journalRef}
              style={{
                maxHeight: 140, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1,
                background: 'rgba(0,0,0,0.15)', borderRadius: 4, padding: '4px 6px',
                fontFamily: 'Consolas, monospace', fontSize: '0.64rem', lineHeight: 1.5,
              }}
            >
              {shownJournal.map((e, i) => (
                <div key={i} style={{ color: KIND_COLOR[e.kind] ?? 'inherit' }}>
                  <span style={{ color: '#666' }}>[g{e.gen}]</span> {e.text}
                </div>
              ))}
            </div>
          </>
        )}

        {seriesEntries.length > 0 && runtime && (
          <>
            <div style={{ color: '#888', fontWeight: 600, marginTop: 2 }}>Series</div>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.64rem' }}>
              <thead>
                <tr style={{ color: '#888', textAlign: 'left' }}>
                  <th style={{ padding: '1px 4px' }}>name</th>
                  <th style={{ padding: '1px 4px' }}>n</th>
                  <th style={{ padding: '1px 4px' }}>mean</th>
                  <th style={{ padding: '1px 4px' }}>std</th>
                  <th style={{ padding: '1px 4px' }}>min</th>
                  <th style={{ padding: '1px 4px' }}>max</th>
                </tr>
              </thead>
              <tbody>
                {seriesEntries.map(([name, s]) => {
                  const stat = (op: string) => fmt(statFor(s.values, op));
                  return (
                    <tr key={name}>
                      <td style={{ padding: '1px 4px' }} title={`scope: ${s.scope}`}>{name}</td>
                      <td style={{ padding: '1px 4px' }}>{s.values.length}</td>
                      <td style={{ padding: '1px 4px' }}>{stat('mean')}</td>
                      <td style={{ padding: '1px 4px' }}>{stat('std')}</td>
                      <td style={{ padding: '1px 4px' }}>{stat('min')}</td>
                      <td style={{ padding: '1px 4px' }}>{stat('max')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {runtime && (journal.length > 0 || seriesEntries.length > 0) && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className={styles.controlButton}
              style={{ flex: 1 }}
              onClick={() => download(runtime.exportSeriesCSV(), `${fname}_series.csv`, 'text/csv')}
              disabled={seriesEntries.length === 0}
            >
              ⤓ CSV
            </button>
            <button
              className={styles.controlButton}
              style={{ flex: 1 }}
              onClick={() => download(runtime.exportJSON(), `${fname}_experiment.json`, 'application/json')}
            >
              ⤓ JSON
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Local two-pass stats mirror (display-only; the runtime owns the canonical
 *  statOf used by Series Statistic nodes). */
function statFor(values: number[], op: string): number {
  const n = values.length;
  if (n === 0) return NaN;
  switch (op) {
    case 'mean': return values.reduce((a, b) => a + b, 0) / n;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    case 'std': {
      if (n < 2) return 0;
      const mean = values.reduce((a, b) => a + b, 0) / n;
      return Math.sqrt(values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
    }
    default: return NaN;
  }
}

/**
 * Experiments panel — the simulator UI for the Overseer (experiment
 * orchestration) graph. Rendered ONLY when `model.overseerConfig?.enabled`
 * (with the feature off there is no trace of it in the simulator).
 *
 * Pure view over the OverseerRuntime's Journal + Series stores (the parent
 * bumps `version` on every runtime update). Run/Abort + CSV/JSON export.
 */
import { useEffect, useRef, useState } from 'react';
import styles from './SimulatorView.module.css';
import type { OverseerRuntime, OverseerSeries, OverseerSpatialSeries, SpatialAggregate, SpatialAxisMeta } from './engine/overseerRuntime';

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
  /** Axis metadata for a spatial indicator (chart X labels). */
  spatialMeta?: (indicatorId: string) => SpatialAxisMeta | null;
  onRun: () => void;
  onAbort: () => void;
}

const KIND_COLOR: Record<string, string> = {
  text: 'inherit',
  milestone: 'var(--color-accent, #e8a13a)',
  warn: '#e0a04d',
  error: '#e05d5d',
};

/** Series palette for the spatial aggregate charts (insertion order). */
const SPATIAL_PALETTE = ['#6fd08c', '#e05d5d', '#4cc9f0', '#e8a13a', '#9b7fd4', '#f0a8d0'];
const ACCENT = '#e8a13a';

type ScalarChartMode = 'hist' | 'runs';

/** A scalar sample series (one value per Collect Sample) as a figure: a
 *  HISTOGRAM of the value distribution across the collected samples (the
 *  classic replicate-distribution figure) OR a per-run SEQUENCE (value vs run
 *  index). Auto-rendered for every scalar series so an experiment produces real
 *  figures, not just a text report. */
function ScalarSeriesChart({ name, series, mode, onToggleMode, version }: {
  name: string;
  series: OverseerSeries;
  mode: ScalarChartMode;
  onToggleMode: () => void;
  version: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const values = series.values;

  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const cssW = Math.max(120, wrap.clientWidth);
    const cssH = 120;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (values.length === 0) return;

    const padL = 26, padR = 6, padT = 6, padB = 16;
    const plotW = cssW - padL - padR, plotH = cssH - padT - padB;
    ctx.font = '9px sans-serif';

    const axis = (yLabelTop: string) => {
      ctx.strokeStyle = 'rgba(139,147,161,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(139,147,161,0.9)';
      ctx.textAlign = 'right';
      ctx.fillText(yLabelTop, padL - 3, padT + 8);
      ctx.fillText('0', padL - 3, padT + plotH);
    };

    if (mode === 'hist') {
      const min = Math.min(...values), max = Math.max(...values);
      const span = max - min;
      // Bin count ~ sqrt(n) nudged up, clamped; degenerate (all-equal) → 1 bin.
      const nb = span === 0 ? 1 : Math.max(5, Math.min(14, Math.round(Math.sqrt(values.length)) + 2));
      const binW = span === 0 ? 1 : span / nb;
      const counts = new Array<number>(nb).fill(0);
      for (const v of values) {
        let b = span === 0 ? 0 : Math.floor((v - min) / binW);
        if (b >= nb) b = nb - 1;
        if (b < 0) b = 0;
        counts[b]!++;
      }
      const maxC = Math.max(...counts, 1);
      axis(String(maxC));
      // bars
      const gap = 1;
      const bw = plotW / nb;
      ctx.fillStyle = ACCENT;
      for (let b = 0; b < nb; b++) {
        const h = (counts[b]! / maxC) * plotH;
        ctx.fillRect(padL + b * bw + gap, padT + plotH - h, Math.max(1, bw - 2 * gap), h);
      }
      // mean line
      const mean = values.reduce((a, x) => a + x, 0) / values.length;
      const mx = span === 0 ? padL + plotW / 2 : padL + ((mean - min) / span) * plotW;
      ctx.strokeStyle = '#4cc9f0';
      ctx.setLineDash([3, 2]);
      ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      // x labels: min .. max
      ctx.fillStyle = 'rgba(139,147,161,0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(fmt(min), padL, cssH - 4);
      ctx.textAlign = 'right';
      ctx.fillText(fmt(max), padL + plotW, cssH - 4);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#4cc9f0';
      ctx.fillText('μ ' + fmt(mean), mx, padT + 8);
    } else {
      // runs: value vs run index
      const min = Math.min(...values, 0), max = Math.max(...values);
      const span = max - min || 1;
      axis(fmt(max));
      const x = (i: number) => values.length <= 1 ? padL : padL + (i / (values.length - 1)) * plotW;
      const y = (v: number) => padT + plotH - ((v - min) / span) * plotH;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      values.forEach((v, i) => { const px = x(i), py = y(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
      ctx.fillStyle = ACCENT;
      values.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 1.6, 0, Math.PI * 2); ctx.fill(); });
      ctx.fillStyle = 'rgba(139,147,161,0.9)';
      ctx.textAlign = 'left';
      ctx.fillText('run 1', padL, cssH - 4);
      ctx.textAlign = 'right';
      ctx.fillText('run ' + values.length, padL + plotW, cssH - 4);
    }
  }, [values, mode, version]);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
        <span style={{ color: '#888', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</span>
        <button
          className={styles.controlButton}
          style={{ fontSize: '0.6rem', padding: '1px 6px', flex: 'none' }}
          onClick={onToggleMode}
          title="Toggle histogram (distribution across runs) vs per-run sequence"
        >
          {mode === 'hist' ? '📊 Histogram' : '📈 Runs'}
        </button>
      </div>
      <canvas ref={canvasRef} />
    </div>
  );
}

interface SpatialChartEntry {
  name: string;
  series: OverseerSpatialSeries;
  agg: SpatialAggregate;
  color: string;
}

/** One aggregate chart: faint individual run-curves + a σ band + the bold mean
 *  per series — the replicate-averaged chromatogram. */
function SpatialAggregateChart({ chart, entries, meta, version }: {
  chart: string;
  entries: SpatialChartEntry[];
  meta: SpatialAxisMeta | null;
  version: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const cssW = Math.max(120, wrap.clientWidth);
    const cssH = 130;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 30, padR = 6, padT = 6, padB = 16;
    const plotW = cssW - padL - padR, plotH = cssH - padT - padB;
    const bins = entries.reduce((m, e) => Math.max(m, e.agg.mean.length), 0);
    if (bins < 2) return;
    // Y max over mean+σ AND the individual runs so nothing clips.
    let yMax = 1;
    for (const e of entries) {
      for (let b = 0; b < e.agg.mean.length; b++) yMax = Math.max(yMax, e.agg.mean[b]! + e.agg.std[b]!);
      for (const r of e.series.runs) for (const v of r) yMax = Math.max(yMax, v);
    }
    yMax *= 1.06;
    const x = (b: number) => padL + (b / (bins - 1)) * plotW;
    const y = (v: number) => padT + plotH - (v / yMax) * plotH;

    // axes
    ctx.strokeStyle = 'rgba(139,147,161,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = 'rgba(139,147,161,0.9)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(yMax)), padL - 3, padT + 8);
    ctx.fillText('0', padL - 3, padT + plotH);
    // X labels: first + last position (bin × binSize when known).
    const binSize = meta?.binSize ?? 1;
    const axisName = meta?.axisName ?? 'bin';
    ctx.textAlign = 'left';
    ctx.fillText(`${axisName} 0`, padL, cssH - 4);
    ctx.textAlign = 'right';
    ctx.fillText(String((bins - 1) * binSize + (binSize > 1 ? binSize - 1 : 0)), padL + plotW, cssH - 4);

    const drawCurve = (curve: number[], stroke: string, width: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let b = 0; b < curve.length; b++) {
        const px = x(b), py = y(curve[b]!);
        if (b === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    for (const e of entries) {
      // faint individual replicates
      for (const r of e.series.runs) drawCurve(r, e.color, 1, 0.10);
      // σ band
      if (e.agg.n >= 2) {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        for (let b = 0; b < e.agg.mean.length; b++) {
          const px = x(b), py = y(e.agg.mean[b]! + e.agg.std[b]!);
          if (b === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        for (let b = e.agg.mean.length - 1; b >= 0; b--) {
          ctx.lineTo(x(b), y(Math.max(0, e.agg.mean[b]! - e.agg.std[b]!)));
        }
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // bold mean
      drawCurve(e.agg.mean, e.color, 2, 1);
    }
  }, [entries, meta, version]);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <div style={{ color: '#888', fontWeight: 600, marginTop: 2 }}>{chart}</div>
      <canvas ref={canvasRef} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: '0.62rem' }}>
        {entries.map(e => (
          <span key={e.name} style={{ color: e.color }}>
            ━ {e.name} <span style={{ color: '#888' }}>(n={e.agg.n}, mean ± σ)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ExperimentsPanel(props: ExperimentsPanelProps) {
  const { runtime, running, compileError, hasExperiment, modelName, spatialMeta, onRun, onAbort } = props;
  const journalRef = useRef<HTMLDivElement | null>(null);
  // Per-series chart mode (histogram vs run-sequence); defaults to histogram.
  const [scalarModes, setScalarModes] = useState<Record<string, ScalarChartMode>>({});

  // Autoscroll the journal to the newest entry on every update.
  useEffect(() => {
    const el = journalRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.version, runtime?.journal.length]);

  const seriesEntries = runtime ? [...runtime.series.entries()] : [];
  // Spatial series grouped by chart name; palette assigned by insertion order.
  const spatialCharts = new Map<string, SpatialChartEntry[]>();
  if (runtime) {
    let colorIdx = 0;
    for (const [name, s] of runtime.spatialSeries) {
      if (s.runs.length === 0) continue;
      const entry: SpatialChartEntry = {
        name, series: s, agg: runtime.spatialAggregate(name),
        color: SPATIAL_PALETTE[colorIdx++ % SPATIAL_PALETTE.length]!,
      };
      const group = spatialCharts.get(s.chart) ?? [];
      group.push(entry);
      spatialCharts.set(s.chart, group);
    }
  }
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
            {/* A figure per scalar series — histogram of the replicate
                distribution (default) or a per-run sequence. */}
            {seriesEntries.filter(([, s]) => s.values.length >= 2).map(([name, s]) => (
              <ScalarSeriesChart
                key={name}
                name={name}
                series={s}
                mode={scalarModes[name] ?? 'hist'}
                onToggleMode={() => setScalarModes(m => ({ ...m, [name]: (m[name] ?? 'hist') === 'hist' ? 'runs' : 'hist' }))}
                version={props.version}
              />
            ))}
          </>
        )}

        {spatialCharts.size > 0 && runtime && (
          <>
            {[...spatialCharts.entries()].map(([chart, entries]) => (
              <SpatialAggregateChart
                key={chart}
                chart={chart}
                entries={entries}
                meta={spatialMeta?.(entries[0]!.series.indicatorId) ?? null}
                version={props.version}
              />
            ))}
          </>
        )}

        {runtime && (journal.length > 0 || seriesEntries.length > 0 || spatialCharts.size > 0) && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className={styles.controlButton}
              style={{ flex: 1 }}
              onClick={() => download(runtime.exportSeriesCSV(), `${fname}_series.csv`, 'text/csv')}
              disabled={seriesEntries.length === 0 && spatialCharts.size === 0}
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

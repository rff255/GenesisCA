import { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { useThemeTokens } from '../styles/useThemeTokens';

interface Props {
  /** Per-series position histogram: series key → counts indexed by position
   *  bin (all arrays the same length = bin count). One curve per series — the
   *  chromatogram shape. */
  data: Record<string, number[]>;
  /** Which grid axis the position bins span. Drives the X-axis label. */
  axis: 'rows' | 'columns';
  /** Grid length along `axis` (rows for 'rows', columns for 'columns'). Used to
   *  label the X-axis endpoints with real positions; falls back to bin indices
   *  when absent. */
  axisLength?: number;
  height: number;
}

const TOKEN_NAMES = [
  '--chart-axis', '--chart-label',
  '--chart-color-1', '--chart-color-2', '--chart-color-3', '--chart-color-4',
  '--chart-color-5', '--chart-color-6', '--chart-color-7', '--chart-color-8',
  '--chart-color-9', '--chart-color-10',
  '--color-text-secondary', '--color-text-tertiary',
] as const;
const LABEL_FONT = '7.5px monospace';
const LEFT_MARGIN = 24;
const BOTTOM_MARGIN = 10;
const RIGHT_PAD = 1;
const TOP_PAD = 1;

function formatAxisValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

/** Order series so colors stay stable as the key set changes between steps.
 *  Numeric-leading keys (integer values "2"/"10", float value-bins
 *  "0.00–0.50") sort by their leading number; everything else (tag names,
 *  true/false) sorts as strings. */
function compareSeriesKeys(a: string, b: string): number {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum && bNum) return a.localeCompare(b);
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.localeCompare(b);
}

export function IndicatorSpatialChart({ data, axis, axisLength, height }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const tokens = useThemeTokens(TOKEN_NAMES);
  const AXIS_COLOR = tokens[0] || '#506070';
  const LABEL_COLOR = tokens[1] || '#8090a0';
  const PALETTE = tokens.slice(2, 12).map(c => c || '#888');
  const LEGEND_LABEL_COLOR = tokens[12] || '#aab';
  const LEGEND_VALUE_COLOR = tokens[13] || '#cdd';
  const colorFor = (idx: number): string => PALETTE[idx % PALETTE.length]!;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        if (w > 0) setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (width > 0) return;
    const el = wrapRef.current;
    if (!el) return;
    const w = Math.floor(el.clientWidth);
    if (w > 0) setWidth(w);
  });

  const categories = Object.keys(data).sort(compareSeriesKeys);
  const binCount = categories.reduce((m, k) => Math.max(m, (data[k] || []).length), 0);
  const legendHeight = 14;
  const plotHeight = Math.max(20, height - legendHeight);
  const axisName = axis === 'rows' ? 'row' : 'column';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 40 || categories.length === 0 || binCount === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = plotHeight * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, plotHeight);

    const plotLeft = LEFT_MARGIN;
    const plotRight = width - RIGHT_PAD;
    const plotTop = TOP_PAD;
    const plotBottom = plotHeight - BOTTOM_MARGIN;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    // Y range across ALL series so curves share one scale. Anchor the floor at
    // 0 (counts are non-negative; a per-bin float total could dip below 0, so
    // keep any negative min) and pad the top a touch.
    let yMin = 0, yMax = -Infinity;
    for (const k of categories) {
      const arr = data[k] || [];
      for (const v of arr) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    if (!Number.isFinite(yMax)) return;
    if (yMin === yMax) yMax = yMin + 1;
    yMax += (yMax - yMin) * 0.06;
    const yRange = yMax - yMin;

    // Y-axis labels
    ctx.font = LABEL_FONT;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(formatAxisValue(yMax), LEFT_MARGIN - 2, plotTop);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatAxisValue(yMin), LEFT_MARGIN - 2, plotBottom);

    // X-axis labels: real grid positions when axisLength is known, else bins.
    const xEnd = axisLength != null && axisLength > 0 ? axisLength - 1 : binCount - 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('0', plotLeft, plotBottom + 1);
    ctx.textAlign = 'center';
    ctx.fillText(axisName, (plotLeft + plotRight) / 2, plotBottom + 1);
    ctx.textAlign = 'right';
    ctx.fillText(String(xEnd), plotRight, plotBottom + 1);

    // Axis lines
    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    // One curve per series — all series share the same bin axis (equal length,
    // no right-align/scroll: spatial X is fixed by the grid, not by time).
    const xStep = binCount > 1 ? plotW / (binCount - 1) : 0;
    const toX = (i: number) => plotLeft + (binCount > 1 ? i * xStep : plotW / 2);
    const toY = (v: number) => plotTop + plotH - ((v - yMin) / yRange) * plotH;
    for (let ci = 0; ci < categories.length; ci++) {
      const arr = data[categories[ci]!] || [];
      if (arr.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(arr[0]!));
      for (let i = 1; i < arr.length; i++) ctx.lineTo(toX(i), toY(arr[i]!));
      ctx.strokeStyle = colorFor(ci);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, width, plotHeight, binCount, axisName, axisLength, categories.length, categories.join('|'), AXIS_COLOR, LABEL_COLOR, PALETTE.join(',')]);

  // Wrapper always mounts so ResizeObserver can attach on first render.
  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      {width > 0 && (
        <canvas
          ref={canvasRef}
          style={{ width, height: plotHeight, display: 'block' }}
        />
      )}
      {/* Legend — one swatch per series, with that series' total population. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '2px 8px',
        marginTop: 2, fontSize: '0.62rem', color: LEGEND_LABEL_COLOR,
        lineHeight: 1.2,
      }}>
        {categories.map((cat, ci) => {
          const arr = data[cat] || [];
          let sum = 0;
          for (const v of arr) sum += v;
          return (
            <span key={cat} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{
                display: 'inline-block', width: 8, height: 2,
                background: colorFor(ci), borderRadius: 1,
              }} />
              <span title={cat}>{cat}</span>
              <span style={{ color: LEGEND_VALUE_COLOR }}>{formatAxisValue(sum)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

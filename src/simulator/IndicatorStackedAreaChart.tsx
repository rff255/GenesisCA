import { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { useThemeTokens } from '../styles/useThemeTokens';
import type { IndicatorChartSettings } from '../model/types';
import {
  applyAxisOverrides, hasFixedAxis, tickCount,
  chartSettingsKey, drawIntermediateYTicks,
} from './indicatorChartSettings';

interface Props {
  /** Per-category history: category key → array of counts over time. */
  data: Record<string, number[]>;
  generation: number;
  height: number;
  /** Categories the user has dimmed via legend click (display-only, runtime). */
  hidden?: Set<string>;
  /** Toggle a category's visibility — fired on legend-entry click. */
  onToggleCategory?: (category: string) => void;
  /** Effective chart settings (model defaults merged with sim overrides). */
  settings?: IndicatorChartSettings;
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

/** Inject alpha into a hex colour so filled areas don't obliterate each other
 *  visually. Accepts `#RRGGBB`; returns `rgba(r,g,b,a)`. Falls back to the
 *  input string unchanged for non-hex inputs. */
function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatAxisValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

export function IndicatorStackedAreaChart({ data, generation, height, hidden, onToggleCategory, settings }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const tokens = useThemeTokens(TOKEN_NAMES);
  const AXIS_COLOR = tokens[0] || '#506070';
  const LABEL_COLOR = tokens[1] || '#8090a0';
  const PALETTE = tokens.slice(2, 12).map(c => c || '#888');
  const LEGEND_LABEL_COLOR = tokens[12] || '#aab';
  const LEGEND_VALUE_COLOR = tokens[13] || '#cdd';
  // Per-series color overrides win over the index-keyed theme palette.
  const colorFor = (idx: number, cat: string): string =>
    settings?.seriesColors?.[cat] ?? PALETTE[idx % PALETTE.length]!;

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

  // colorFor() is keyed by index in this full sorted list, so hiding a band
  // never recolors the others. Hidden bands are skipped from the cumulative
  // stack + yMax (so totals rescale) but keep their colour slot.
  const categories = Object.keys(data).sort();
  const isHidden = (c: string) => !!hidden && hidden.has(c);
  const hiddenKey = hidden ? [...hidden].sort().join('|') : '';
  const legendHeight = 14;
  const plotHeight = Math.max(20, height - legendHeight);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 40 || categories.length === 0) return;
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

    // Determine maxLen across categories; shorter series are left-padded with 0
    // so stacked totals line up on the right (latest sample).
    let maxLen = 0;
    for (const k of categories) {
      const arr = data[k] || [];
      if (arr.length > maxLen) maxLen = arr.length;
    }
    if (maxLen < 2) {
      ctx.strokeStyle = AXIS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, plotTop);
      ctx.lineTo(plotLeft, plotBottom);
      ctx.lineTo(plotRight, plotBottom);
      ctx.stroke();
      return;
    }

    // Build left-padded aligned arrays and cumulative-sum stacks.
    const aligned: number[][] = categories.map(k => {
      const arr = data[k] || [];
      const pad = new Array(maxLen - arr.length).fill(0);
      return pad.concat(arr);
    });

    // yMax = max stacked total at any timestep
    let yMax = 0;
    for (let t = 0; t < maxLen; t++) {
      let sum = 0;
      for (let c = 0; c < categories.length; c++) {
        if (isHidden(categories[c]!)) continue;
        sum += aligned[c]![t]!;
      }
      if (sum > yMax) yMax = sum;
    }
    if (yMax <= 0) yMax = 1;
    let yMin = 0;
    // Stacked bands always grow from 0, but a fixed window is still honoured
    // (e.g. pin yMax so the scale doesn't jump as totals change).
    [yMin, yMax] = applyAxisOverrides(yMin, yMax, settings);
    const yRange = yMax - yMin;

    // Y labels
    ctx.font = LABEL_FONT;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(formatAxisValue(yMax), LEFT_MARGIN - 2, plotTop);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatAxisValue(yMin), LEFT_MARGIN - 2, plotBottom);

    // X labels
    const genStart = Math.max(0, generation - maxLen + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(genStart), plotLeft, plotBottom + 1);
    ctx.textAlign = 'right';
    ctx.fillText(String(generation), plotRight, plotBottom + 1);

    // Axis lines
    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    // Intermediate tick gridlines + labels (yTicks > 2)
    drawIntermediateYTicks(ctx, {
      ticks: tickCount(settings), yMin, yMax,
      plotLeft, plotRight, plotTop, plotBottom,
      axisColor: AXIS_COLOR, labelColor: LABEL_COLOR,
      font: LABEL_FONT, format: formatAxisValue,
    });

    // With a fixed axis, stacked totals can exceed the window — clip.
    const clipped = hasFixedAxis(settings);
    if (clipped) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotLeft, plotTop, plotW, plotH);
      ctx.clip();
    }

    const xStep = plotW / (maxLen - 1);
    const toX = (i: number) => plotLeft + i * xStep;
    const toY = (v: number) => plotTop + plotH - ((v - yMin) / yRange) * plotH;

    // Cumulative lower bound per timestep (starts at 0 for bottom band, grows per category)
    const lower = new Array(maxLen).fill(0);

    for (let ci = 0; ci < categories.length; ci++) {
      if (isHidden(categories[ci]!)) continue;
      const arr = aligned[ci]!;
      // Build upper line for this band = lower + arr
      const upper = arr.map((v, i) => lower[i] + v);

      ctx.beginPath();
      ctx.moveTo(toX(0), toY(upper[0]!));
      for (let i = 1; i < maxLen; i++) ctx.lineTo(toX(i), toY(upper[i]!));
      // Close via the lower line (backwards)
      for (let i = maxLen - 1; i >= 0; i--) ctx.lineTo(toX(i), toY(lower[i]));
      ctx.closePath();
      ctx.fillStyle = withAlpha(colorFor(ci, categories[ci]!), 0.55);
      ctx.fill();
      ctx.strokeStyle = colorFor(ci, categories[ci]!);
      ctx.lineWidth = 0.6;
      ctx.stroke();

      for (let i = 0; i < maxLen; i++) lower[i] = upper[i]!;
    }

    if (clipped) ctx.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, generation, width, plotHeight, categories.length, categories.join('|'), hiddenKey, AXIS_COLOR, LABEL_COLOR, PALETTE.join(','), chartSettingsKey(settings)]);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      {width > 0 && (
        <canvas
          ref={canvasRef}
          style={{ width, height: plotHeight, display: 'block' }}
        />
      )}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '2px 8px',
        marginTop: 2, fontSize: '0.62rem', color: LEGEND_LABEL_COLOR,
        lineHeight: 1.2,
      }}>
        {categories.map((cat, ci) => {
          const arr = data[cat] || [];
          const cur = arr.length > 0 ? arr[arr.length - 1] : undefined;
          const off = isHidden(cat);
          return (
            <span
              key={cat}
              onClick={onToggleCategory ? () => onToggleCategory(cat) : undefined}
              title={off ? `${cat} (hidden — click to show)` : `${cat} (click to hide)`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                cursor: onToggleCategory ? 'pointer' : 'default',
                opacity: off ? 0.4 : 1,
                textDecoration: off ? 'line-through' : 'none',
                userSelect: 'none',
              }}
            >
              <span style={{
                display: 'inline-block', width: 8, height: 8,
                background: withAlpha(colorFor(ci, cat), 0.55),
                border: `1px solid ${colorFor(ci, cat)}`,
                borderRadius: 1,
              }} />
              <span>{cat}</span>
              <span style={{ color: LEGEND_VALUE_COLOR }}>{cur ?? ''}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

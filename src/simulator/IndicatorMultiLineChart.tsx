import { useRef, useEffect, useLayoutEffect, useState } from 'react';

interface Props {
  /** Per-category history: category key → array of counts over time. */
  data: Record<string, number[]>;
  generation: number;
  height: number;
}

const AXIS_COLOR = '#506070';
const LABEL_COLOR = '#8090a0';
const LABEL_FONT = '7.5px monospace';
const LEFT_MARGIN = 24;
const BOTTOM_MARGIN = 10;
const RIGHT_PAD = 1;
const TOP_PAD = 1;

// Fixed palette — cycles when categories exceed palette length.
const PALETTE = [
  '#4cc9f0', '#f77f00', '#90e0ef', '#e07a5f',
  '#b5179e', '#ffd166', '#06d6a0', '#e5383b',
  '#8ecae6', '#fb8500',
];

function colorFor(idx: number): string {
  return PALETTE[idx % PALETTE.length]!;
}

function formatAxisValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

export function IndicatorMultiLineChart({ data, generation, height }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

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

  // Stable ordering so line colors don't flicker as keys are re-iterated.
  const categories = Object.keys(data).sort();
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

    // Y range across ALL categories, so lines share the same scale.
    let yMin = Infinity, yMax = -Infinity;
    let maxLen = 0;
    for (const k of categories) {
      const arr = data[k] || [];
      if (arr.length > maxLen) maxLen = arr.length;
      for (const v of arr) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const yPad = (yMax - yMin) * 0.06;
    yMin -= yPad;
    yMax += yPad;
    const yRange = yMax - yMin;

    if (maxLen < 2) {
      // Still draw axis box so the user sees the chart area even before 2nd sample
      ctx.strokeStyle = AXIS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, plotTop);
      ctx.lineTo(plotLeft, plotBottom);
      ctx.lineTo(plotRight, plotBottom);
      ctx.stroke();
      return;
    }

    // Y-axis labels
    ctx.font = LABEL_FONT;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(formatAxisValue(yMax), LEFT_MARGIN - 2, plotTop);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatAxisValue(yMin), LEFT_MARGIN - 2, plotBottom);

    // X-axis labels (based on the longest series — assume all series align on the right)
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

    // One line per category
    for (let ci = 0; ci < categories.length; ci++) {
      const cat = categories[ci]!;
      const arr = data[cat] || [];
      if (arr.length < 2) continue;
      // Right-align shorter series against the latest generation
      const offset = maxLen - arr.length;
      const xStep = plotW / (maxLen - 1);
      const toX = (i: number) => plotLeft + (i + offset) * xStep;
      const toY = (v: number) => plotTop + plotH - ((v - yMin) / yRange) * plotH;
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(arr[0]!));
      for (let i = 1; i < arr.length; i++) ctx.lineTo(toX(i), toY(arr[i]!));
      ctx.strokeStyle = colorFor(ci);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, generation, width, plotHeight, categories.length, categories.join('|')]);

  // Wrapper always mounts so ResizeObserver can attach on first render.
  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      {width > 0 && (
        <canvas
          ref={canvasRef}
          style={{ width, height: plotHeight, display: 'block' }}
        />
      )}
      {/* Legend — one swatch per category, with current value */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '2px 8px',
        marginTop: 2, fontSize: '0.62rem', color: '#aab',
        lineHeight: 1.2,
      }}>
        {categories.map((cat, ci) => {
          const arr = data[cat] || [];
          const cur = arr.length > 0 ? arr[arr.length - 1] : undefined;
          return (
            <span key={cat} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{
                display: 'inline-block', width: 8, height: 2,
                background: colorFor(ci), borderRadius: 1,
              }} />
              <span title={cat}>{cat}</span>
              <span style={{ color: '#cdd' }}>{cur ?? ''}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

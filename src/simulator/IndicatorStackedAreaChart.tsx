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

const PALETTE = [
  '#4cc9f0', '#f77f00', '#90e0ef', '#e07a5f',
  '#b5179e', '#ffd166', '#06d6a0', '#e5383b',
  '#8ecae6', '#fb8500',
];

function colorFor(idx: number): string {
  return PALETTE[idx % PALETTE.length]!;
}

/** Inject alpha into a hex colour so filled areas don't obliterate each other
 *  visually. Accepts `#RRGGBB`; returns `rgba(r,g,b,a)`. */
function withAlpha(hex: string, alpha: number): string {
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

export function IndicatorStackedAreaChart({ data, generation, height }: Props) {
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
      for (let c = 0; c < categories.length; c++) sum += aligned[c]![t]!;
      if (sum > yMax) yMax = sum;
    }
    if (yMax <= 0) yMax = 1;
    const yMin = 0;
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

    const xStep = plotW / (maxLen - 1);
    const toX = (i: number) => plotLeft + i * xStep;
    const toY = (v: number) => plotTop + plotH - ((v - yMin) / yRange) * plotH;

    // Cumulative lower bound per timestep (starts at 0 for bottom band, grows per category)
    const lower = new Array(maxLen).fill(0);

    for (let ci = 0; ci < categories.length; ci++) {
      const arr = aligned[ci]!;
      // Build upper line for this band = lower + arr
      const upper = arr.map((v, i) => lower[i] + v);

      ctx.beginPath();
      ctx.moveTo(toX(0), toY(upper[0]!));
      for (let i = 1; i < maxLen; i++) ctx.lineTo(toX(i), toY(upper[i]!));
      // Close via the lower line (backwards)
      for (let i = maxLen - 1; i >= 0; i--) ctx.lineTo(toX(i), toY(lower[i]));
      ctx.closePath();
      ctx.fillStyle = withAlpha(colorFor(ci), 0.55);
      ctx.fill();
      ctx.strokeStyle = colorFor(ci);
      ctx.lineWidth = 0.6;
      ctx.stroke();

      for (let i = 0; i < maxLen; i++) lower[i] = upper[i]!;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, generation, width, plotHeight, categories.length, categories.join('|')]);

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
        marginTop: 2, fontSize: '0.62rem', color: '#aab',
        lineHeight: 1.2,
      }}>
        {categories.map((cat, ci) => {
          const arr = data[cat] || [];
          const cur = arr.length > 0 ? arr[arr.length - 1] : undefined;
          return (
            <span key={cat} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8,
                background: withAlpha(colorFor(ci), 0.55),
                border: `1px solid ${colorFor(ci)}`,
                borderRadius: 1,
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

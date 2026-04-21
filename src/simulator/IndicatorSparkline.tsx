import { useRef, useEffect, useLayoutEffect, useState } from 'react';

interface SparklineProps {
  data: number[];
  generation: number;
  height: number;
}

const LINE_COLOR = '#4cc9f0';
const FILL_COLOR = 'rgba(76, 201, 240, 0.12)';
const AXIS_COLOR = '#506070';
const LABEL_COLOR = '#8090a0';
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

export function IndicatorSparkline({ data, generation, height }: SparklineProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  // Measure container width. ResizeObserver keeps `width` in sync as the
  // element resizes AND when it transitions from display:none (0x0 content
  // rect) to a rendered size — common here, since the simulator panel can be
  // mounted while hidden.
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

  // Belt-and-suspenders: if we've received data but width hasn't been measured
  // yet (ResizeObserver can be lazy on some browsers when the element first
  // becomes visible), pull the width directly after each render.
  useLayoutEffect(() => {
    if (width > 0) return;
    const el = wrapRef.current;
    if (!el) return;
    const w = Math.floor(el.clientWidth);
    if (w > 0) setWidth(w);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2 || width < 40) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const plotLeft = LEFT_MARGIN;
    const plotRight = width - RIGHT_PAD;
    const plotTop = TOP_PAD;
    const plotBottom = height - BOTTOM_MARGIN;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    // Y range
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i]! < yMin) yMin = data[i]!;
      if (data[i]! > yMax) yMax = data[i]!;
    }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const yPad = (yMax - yMin) * 0.06;
    yMin -= yPad;
    yMax += yPad;
    const yRange = yMax - yMin;

    const n = data.length;
    const xStep = plotW / (n - 1);
    const toX = (i: number) => plotLeft + i * xStep;
    const toY = (v: number) => plotTop + plotH - ((v - yMin) / yRange) * plotH;

    // Y-axis labels
    ctx.font = LABEL_FONT;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(formatAxisValue(yMax), LEFT_MARGIN - 2, plotTop);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatAxisValue(yMin), LEFT_MARGIN - 2, plotBottom);

    // X-axis labels
    const genStart = Math.max(0, generation - n + 1);
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

    // Fill
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(data[0]!));
    for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i]!));
    ctx.lineTo(toX(n - 1), plotBottom);
    ctx.lineTo(toX(0), plotBottom);
    ctx.closePath();
    ctx.fillStyle = FILL_COLOR;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(data[0]!));
    for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i]!));
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, data.length, data[data.length - 1], generation, width, height]);

  // Always mount the wrapper div so the ResizeObserver (set up in an empty-deps
  // effect above) sees a real DOM node on first mount and can measure width.
  // If we early-return null when `data.length < 2`, the wrapper never attaches,
  // `width` stays at 0, and the canvas never renders — even after data grows —
  // until the component unmounts and remounts (e.g. via a collapse/expand
  // cycle). Gate the CANVAS, not the wrapper.
  return (
    <div ref={wrapRef} style={{ width: '100%', height }}>
      {data.length >= 2 && width > 0 && (
        <canvas
          ref={canvasRef}
          style={{ width, height, display: 'block' }}
        />
      )}
    </div>
  );
}

import type { CAModel, Indicator, IndicatorChartSettings } from '../model/types';
import { resolveMaxBonds } from '../model/centerBased';
import { degreeHistogramKeys, isGraphFrequencyMetric, type GraphMetric } from './engine/graphMetrics';

/** Series key used by scalar charts (sparkline) in `seriesColors`. */
export const SCALAR_SERIES_KEY = 'value';

/** Design-time-enumerable series keys for an indicator: scalar 'value',
 *  bool false/true, tag options (sorted — matches the charts' key sort).
 *  Numeric frequency buckets are runtime-only → []. Single source of truth
 *  for BOTH the modeler's chart-defaults editor and the simulator charts'
 *  stable palette indexing: a series' default color is keyed by its position
 *  in THIS list, so filtering categories at runtime (Track Categories) never
 *  shifts the surviving series onto different palette slots. */
export function designTimeSeriesKeys(ind: Indicator, model: CAModel): string[] {
  if (ind.kind === 'standalone') return [SCALAR_SERIES_KEY];
  // GRA P6 — a graph indicator is either a scalar or the degree histogram, whose
  // categories are the FIXED window 0..maxBonds (so they ARE design-time known,
  // unlike numeric linked-frequency buckets).
  if (ind.kind === 'graph') {
    return isGraphFrequencyMetric((ind.graphMetric ?? 'nodeCount') as GraphMetric)
      ? degreeHistogramKeys(resolveMaxBonds(model.centerBased))
      : [SCALAR_SERIES_KEY];
  }
  if (ind.linkedAggregation === 'total') return [SCALAR_SERIES_KEY];
  if (ind.dataType === 'bool') return ['false', 'true'];
  if (ind.dataType === 'tag') {
    const attr = model.attributes.find(a => a.id === ind.linkedAttributeId);
    return [...(attr?.tagOptions ?? [])].sort();
  }
  return [];
}

/** Field-level merge of the model-default settings with the simulator's
 *  runtime override layer — override fields win, per-series colors merge
 *  per key. Both layers optional. */
export function mergeChartSettings(
  base?: IndicatorChartSettings,
  override?: IndicatorChartSettings,
): IndicatorChartSettings {
  if (!base && !override) return {};
  const seriesColors = { ...(base?.seriesColors ?? {}), ...(override?.seriesColors ?? {}) };
  return {
    yMin: override?.yMin ?? base?.yMin,
    yMax: override?.yMax ?? base?.yMax,
    yTicks: override?.yTicks ?? base?.yTicks,
    window: override?.window ?? base?.window,
    ...(Object.keys(seriesColors).length > 0 ? { seriesColors } : {}),
  };
}

/** Effective time-series X-axis window (number of most-recent generations to
 *  show), clamped to a sane range. Absent/invalid → undefined (show all). */
export function historyWindow(s?: IndicatorChartSettings): number | undefined {
  const w = s?.window;
  if (w === undefined || !Number.isFinite(w)) return undefined;
  const n = Math.round(w);
  return n >= 2 ? Math.min(n, INDICATOR_HISTORY_HARD_CAP) : undefined;
}

/** Hard ceiling for stored-history samples per series (bounds memory even when
 *  a very large window is configured). Shared by the worker-message history
 *  collection cap and historyWindow's clamp. */
export const INDICATOR_HISTORY_HARD_CAP = 5000;

/** Default stored-history cap when no larger window is configured. */
export const INDICATOR_HISTORY_DEFAULT_CAP = 500;

/** Slice a time-series array to the last `window` samples (undefined → full). */
export function sliceWindow(data: number[], window?: number): number[] {
  return window !== undefined && data.length > window ? data.slice(-window) : data;
}

/** Apply the fixed-axis overrides to a dynamically-computed [yMin, yMax]
 *  window. Each bound is independent (one can be fixed while the other stays
 *  dynamic); a degenerate user range falls back to a +1 span. */
export function applyAxisOverrides(
  yMin: number,
  yMax: number,
  s?: IndicatorChartSettings,
): [number, number] {
  const lo = s?.yMin !== undefined ? s.yMin : yMin;
  let hi = s?.yMax !== undefined ? s.yMax : yMax;
  if (!(hi > lo)) hi = lo + 1;
  return [lo, hi];
}

/** True when either axis bound is fixed — charts then clip data drawing to the
 *  plot rect, since samples may legitimately fall outside the user's window. */
export function hasFixedAxis(s?: IndicatorChartSettings): boolean {
  return s?.yMin !== undefined || s?.yMax !== undefined;
}

/** Y-axis tick-label count (including the min and max labels). Clamped 2–11;
 *  absent/invalid → 2 (just min+max, the classic look). */
export function tickCount(s?: IndicatorChartSettings): number {
  const t = s?.yTicks;
  if (t === undefined || !Number.isFinite(t)) return 2;
  return Math.max(2, Math.min(11, Math.round(t)));
}

/** Stable dependency key for redraw effects. */
export function chartSettingsKey(s?: IndicatorChartSettings): string {
  return s ? JSON.stringify(s) : '';
}

/** Draw the intermediate Y tick gridlines + labels (the min/max labels are
 *  drawn by each chart already). No-op for the default 2 ticks. */
export function drawIntermediateYTicks(
  ctx: CanvasRenderingContext2D,
  opts: {
    ticks: number;
    yMin: number;
    yMax: number;
    plotLeft: number;
    plotRight: number;
    plotTop: number;
    plotBottom: number;
    axisColor: string;
    labelColor: string;
    font: string;
    format: (v: number) => string;
  },
): void {
  if (opts.ticks <= 2) return;
  for (let t = 1; t < opts.ticks - 1; t++) {
    const frac = t / (opts.ticks - 1);
    const v = opts.yMin + (opts.yMax - opts.yMin) * frac;
    const y = opts.plotBottom - frac * (opts.plotBottom - opts.plotTop);
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = opts.axisColor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(opts.plotLeft, y);
    ctx.lineTo(opts.plotRight, y);
    ctx.stroke();
    ctx.restore();
    ctx.font = opts.font;
    ctx.fillStyle = opts.labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.format(v), opts.plotLeft - 2, y);
  }
}

/** Hex (#rgb/#rrggbb) → rgba() with the given alpha; passthrough otherwise. */
export function withSettingsAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

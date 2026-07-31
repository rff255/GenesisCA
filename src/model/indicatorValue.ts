// Is an indicator's value a SINGLE NUMBER a rule can read?
//
// The rule graph reads an indicator through `Get Indicator`, which compiles to
// `_indicators[<slot>]` — one f64 slot per indicator, on every compile target.
// So a rule can only read an indicator whose value IS one number:
//
//   standalone            → always (the graph writes it; it is a scalar by construction)
//   linked   'total'      → the summed value                            → scalar
//   linked   'frequency'  → { category: count } — a MAP, not a number    → NOT readable
//   graph    scalar metric→ nodeCount / edgeCount / meanDegree / …       → scalar
//   graph    degreeHistogram → { degree: count } — a MAP                 → NOT readable
//   any spatial (xAxis rows/columns/layers) → { key: number[] } per bin  → NOT readable
//
// This is the ONE definition of that rule. It is shared by the Get Indicator
// picker (CaNode), the validation badge (nodeValidation), the simulator's
// scalar-vs-frequency chart branch (IndicatorDisplay) and the worker's scalar
// cache sync — so a value the picker offers is exactly a value the engine can
// deliver, and they cannot drift.
//
// WHY IT EXISTS (a user-reported gap, 2026-07-31): the Get Indicator picker used
// to list `kind === 'standalone'` only. Every shipped agent/GRA model carries ONLY
// graph and linked indicators, so on those models the dropdown was empty but for
// "Select…" — the node could never be configured and read `_indicators[-1]`.
// Reported as "get indicator is not working on agents rule graph canvas".
import type { Indicator } from './types';
import { isGraphFrequencyMetric, DEFAULT_GRAPH_METRIC, type GraphMetric } from '../simulator/engine/graphMetrics';

/** A spatial indicator's value is a per-position-bin array, never one number. */
export function indicatorIsSpatial(ind: Indicator): boolean {
  return ind.xAxis === 'rows' || ind.xAxis === 'columns' || ind.xAxis === 'layers';
}

/** Frequency-SHAPED: the value is a `{ category: number }` map. */
export function indicatorIsFrequencyShaped(ind: Indicator): boolean {
  if (indicatorIsSpatial(ind)) return false;
  if (ind.kind === 'linked') return ind.linkedAggregation === 'frequency';
  if (ind.kind === 'graph') return isGraphFrequencyMetric((ind.graphMetric ?? DEFAULT_GRAPH_METRIC) as GraphMetric);
  return false;
}

/** Why a rule cannot read this indicator as a number — or null when it can.
 *  The string is shown to the user (disabled dropdown entry + validation badge),
 *  so it names the SHAPE, not the internals. */
export function indicatorScalarBlocker(ind: Indicator): string | null {
  if (indicatorIsSpatial(ind)) return 'spatial — one value per position bin, not a single number';
  if (ind.kind === 'linked' && ind.linkedAggregation === 'frequency') return 'a per-category frequency map, not a single number';
  if (ind.kind === 'graph' && isGraphFrequencyMetric((ind.graphMetric ?? DEFAULT_GRAPH_METRIC) as GraphMetric)) {
    return 'a per-degree histogram, not a single number';
  }
  return null;
}

/** Can a rule read this indicator with Get Indicator? */
export function indicatorIsScalar(ind: Indicator): boolean {
  return indicatorScalarBlocker(ind) === null;
}

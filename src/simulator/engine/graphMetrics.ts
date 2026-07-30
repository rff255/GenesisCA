// GRA P6 — graph-global metrics over the bond-graph agent population.
//
// The MEASUREMENT half of the GRA research loop (the search half — seeded table
// Randomize + the Overseer's sweep / replicate statistics / journal / CSV — already
// exists). A `graph` indicator asks the questions a rewriting rule is judged by:
// how many nodes and edges are there, what is the degree distribution, did the
// graph fragment.
//
// This module is the SINGLE implementation, shared by the worker (which feeds it a
// live AgentStore) and `scripts/verify-graph-rewrite.mjs` (which feeds it a
// `getState` payload and then recounts INDEPENDENTLY — the exactness oracle). It
// deliberately takes a NORMALISED view, exactly like the harness's
// `decodeAgentGraph`, so the two can never disagree about what "the graph" is.
//
// **`edgeCount` IS invariant I1** (the handshake lemma, `Σ deg(v) = 2·|E|`), which
// `verify-graph-rewrite.mjs` already checks — so the metric and the invariant
// validate each other: if they ever disagree, exactly one of them is wrong and the
// harness says which.
//
// Freshness (why reading the CPU store is always exact — verified, not assumed):
// every field read here is CPU-AUTHORITATIVE on all three agent targets. Bond
// topology (`bondCount` / `bondPartner`) is only ever mutated by the CPU structural
// phase — the WebGPU behaviour shader reads `bondStore` and, since P3, writes only
// the ATTRIBUTE lanes (`bondAttrWord = 2 + i`, never word 0 = partner). `alive` is
// GPU-written only under `usesSpawn`, which is reconciled by `readbackAgentStep`
// every generation on the per-generation GPU path. The ONE path that can leave the
// CPU mirror stale — the resident batch — requires `maxBonds === 0 && !usesSpawn`
// (see `agentResidentEligible`), so nothing this module reads can have changed
// during it.

/** The measurable graph-global quantities. */
export type GraphMetric =
  | 'nodeCount'
  | 'edgeCount'
  | 'meanDegree'
  | 'maxDegree'
  | 'degreeHistogram'
  | 'componentCount';

export const GRAPH_METRICS: readonly GraphMetric[] = [
  'nodeCount', 'edgeCount', 'meanDegree', 'maxDegree', 'degreeHistogram', 'componentCount',
];

export const DEFAULT_GRAPH_METRIC: GraphMetric = 'nodeCount';

/** UI label + one-line description per metric (the Indicators panel dropdown and
 *  the simulator tooltip both read these — one source of truth). */
export const GRAPH_METRIC_INFO: Record<GraphMetric, { label: string; hint: string }> = {
  nodeCount:       { label: 'Node count (N)',        hint: 'Live agents. O(1).' },
  edgeCount:       { label: 'Edge count (E)',        hint: 'Distinct bonds, via the handshake lemma Sum(degree)/2. O(N).' },
  meanDegree:      { label: 'Mean degree',           hint: '2E / N — the average number of bonds per live agent. O(N).' },
  maxDegree:       { label: 'Max degree',            hint: 'The largest bond count over live agents. O(N).' },
  degreeHistogram: { label: 'Degree histogram',      hint: 'How many agents have each degree 0..maxBonds. Charts as a frequency map. O(N).' },
  componentCount:  { label: 'Connected components',  hint: 'Union-find over the bonds; isolated agents count as one component each. O(E a(N)) — the only non-trivial metric, computed ONLY when an indicator asks for it.' },
};

/** Metrics whose value is a frequency MAP (category -> count) rather than a
 *  scalar. Frequency-shaped means the existing bars / lines / stacked-area chart
 *  machinery renders them with no new chart code, and `ovReadIndicator` reads one
 *  category exactly as it does for a linked-frequency indicator. */
export function isGraphFrequencyMetric(m: GraphMetric): boolean {
  return m === 'degreeHistogram';
}

/** The value's numeric flavour — drives `Indicator.dataType`, hence the
 *  simulator's value formatting (integers plain, decimals to 2 dp). */
export function graphMetricDataType(m: GraphMetric): 'integer' | 'float' {
  return m === 'meanDegree' ? 'float' : 'integer';
}

/** The stable, design-time-enumerable category keys of `degreeHistogram`:
 *  every degree from 0 to `maxBonds` inclusive. Fixed (not observation-driven)
 *  so the series set never changes shape mid-run — which keeps the multi-line /
 *  stacked charts coherent and keeps palette slots pinned by position. */
export function degreeHistogramKeys(maxBonds: number): string[] {
  const n = Math.max(0, Math.floor(maxBonds) || 0);
  const out: string[] = [];
  for (let d = 0; d <= n; d++) out.push(String(d));
  return out;
}

/** The normalised graph view — the same shape the harness's `decodeAgentGraph`
 *  produces, so a live AgentStore and a `getState` payload are interchangeable.
 *  `liveCount` is optional: when absent, `nodeCount` counts the `alive` array. */
export interface GraphMetricView {
  highWater: number;
  maxBonds: number;
  alive: ArrayLike<number>;
  bondCount: ArrayLike<number>;
  bondPartner: ArrayLike<number>;
  liveCount?: number;
}

/** Per-call work counters — the evidence for "zero cost when unused". Both stay
 *  at 0 for a model with no graph indicator because `computeGraphMetrics` is
 *  never reached (the worker gates on `graphDefs.length`), and `components` stays
 *  0 unless an indicator actually asks for it. */
export interface GraphMetricPasses {
  /** O(N) degree scan ran (edge/mean/max/histogram). */
  degree: number;
  /** O(E·α) union-find ran (componentCount only). */
  components: number;
}

export type GraphMetricValue = number | Record<string, number>;

/**
 * Compute exactly the requested metrics over `view`, sharing work:
 *  - ONE O(N) degree pass covers edgeCount / meanDegree / maxDegree / degreeHistogram
 *  - the union-find pass runs ONLY when `componentCount` is requested
 *  - nodeCount is O(1) when the view carries `liveCount`
 *
 * `passes` (optional) accumulates which passes actually ran.
 */
export function computeGraphMetrics(
  view: GraphMetricView,
  metrics: Iterable<GraphMetric>,
  passes?: GraphMetricPasses,
): Partial<Record<GraphMetric, GraphMetricValue>> {
  const want = new Set<GraphMetric>(metrics);
  const out: Partial<Record<GraphMetric, GraphMetricValue>> = {};
  if (want.size === 0) return out;

  const hw = Math.max(0, view.highWater | 0);
  const mb = Math.max(0, view.maxBonds | 0);
  const { alive, bondCount } = view;

  // nodeCount — O(1) from the store's own tally when available. The harness's
  // independent recount scans `alive`, so the exactness test also validates the
  // store's liveCount bookkeeping.
  let live = view.liveCount;
  if (live === undefined) {
    live = 0;
    for (let i = 0; i < hw; i++) if (alive[i]) live++;
  }
  if (want.has('nodeCount')) out.nodeCount = live;

  const needDegree = want.has('edgeCount') || want.has('meanDegree')
    || want.has('maxDegree') || want.has('degreeHistogram');
  if (needDegree) {
    if (passes) passes.degree++;
    let degSum = 0;
    let maxDeg = 0;
    // Fixed-width histogram over 0..maxBonds (see degreeHistogramKeys). A degree
    // outside that window can only exist if I4 (capacity) is already violated;
    // clamping keeps the metric total-consistent instead of silently dropping it.
    const hist = new Int32Array(mb + 1);
    for (let i = 0; i < hw; i++) {
      if (!alive[i]) continue;
      const d = bondCount[i] as number;
      degSum += d;
      if (d > maxDeg) maxDeg = d;
      const slot = d < 0 ? 0 : d > mb ? mb : d;
      hist[slot]!++;
    }
    // I1 — the handshake lemma IS the edge count.
    if (want.has('edgeCount')) out.edgeCount = degSum / 2;
    if (want.has('meanDegree')) out.meanDegree = live > 0 ? degSum / live : 0;
    if (want.has('maxDegree')) out.maxDegree = maxDeg;
    if (want.has('degreeHistogram')) {
      const m: Record<string, number> = {};
      for (let d = 0; d <= mb; d++) m[String(d)] = hist[d]!;
      out.degreeHistogram = m;
    }
  }

  if (want.has('componentCount')) {
    if (passes) passes.components++;
    out.componentCount = countComponents(view, live);
  }

  return out;
}

/** Connected components over the LIVE subgraph — union-find with path halving +
 *  union by size. Isolated live agents count as one component each; an empty
 *  population has 0. Only edges whose partner is live and in range are unioned
 *  (a dangling partner is I3's problem, not this metric's). */
function countComponents(view: GraphMetricView, live: number): number {
  const hw = Math.max(0, view.highWater | 0);
  const mb = Math.max(0, view.maxBonds | 0);
  const { alive, bondCount, bondPartner } = view;
  if (live <= 0 || hw === 0) return 0;

  const parent = new Int32Array(hw);
  const size = new Int32Array(hw);
  for (let i = 0; i < hw; i++) { parent[i] = i; size[i] = 1; }

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { parent[r] = parent[parent[r]!]!; r = parent[r]!; }
    return r;
  };

  let comps = live;
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) continue;
    const n = bondCount[i] as number;
    for (let k = 0; k < n; k++) {
      const p = bondPartner[i * mb + k] as number;
      // Each undirected edge is visited twice (I2); the union is idempotent, so
      // the second visit is a no-op. Skipping p < i would also work but would
      // silently mask a one-sided bond — union both ways and let I2 report it.
      if (p < 0 || p >= hw || p === i || !alive[p]) continue;
      const a = find(i), b = find(p);
      if (a === b) continue;
      if (size[a]! < size[b]!) { parent[a] = b; size[b] = size[b]! + size[a]!; }
      else { parent[b] = a; size[a] = size[a]! + size[b]!; }
      comps--;
    }
  }
  return comps;
}

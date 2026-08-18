/**
 * OverseerRuntime — executes a compiled Overseer driver (see
 * modeler/vpl/compiler/overseer/compile.ts) on the MAIN thread, commanding the
 * sim worker through the existing message protocol exactly like the transport
 * bar does: post a step batch → await the `stepped` ack → decide what to do
 * next. The CA keeps running on whichever compile target the model selects.
 *
 * Message correlation: overseer-issued `step` / `reset` messages carry a
 * `reqId` the worker echoes on the resulting `stepped` (and on the step case's
 * `stopEvent` posts), so residual play-pipeline / paint messages can never be
 * mistaken for a batch ack. The runtime attaches its own worker listener
 * (workers support multiple listeners) and never disturbs SimulatorView's
 * onmessage handler.
 *
 * Results are runtime artifacts (D-OV-6): the Journal (ordered log lines) and
 * the Series store (named sample vectors + stats) live here, are rendered by
 * the Experiments panel, exportable as CSV/JSON — and are never written into
 * the model.
 */

export type IndicatorMap = Record<string, number | Record<string, number> | Record<string, number[]>>;

export interface OverseerJournalEntry {
  /** ms since experiment start */
  t: number;
  /** generation at log time */
  gen: number;
  kind: 'text' | 'milestone' | 'warn' | 'error';
  text: string;
}

export interface OverseerSeries {
  scope: 'run' | 'experiment';
  values: number[];
}

/** A SPATIAL sample series — one number[] (per-position-bin curve) per run,
 *  captured from a spatial indicator by Collect Spatial Sample. The panel
 *  aggregates the runs into a mean ± σ curve (the replicate-averaged
 *  chromatogram of the Kier papers). */
export interface OverseerSpatialSeries {
  /** Chart group — series sharing a chart overlay on the same axes
   *  (e.g. S1 + S2 on one chromatogram). */
  chart: string;
  indicatorId: string;
  category: string;
  /** One captured curve per Collect Spatial Sample execution. */
  runs: number[][];
}

/** Per-bin aggregate of a spatial series across its collected runs. */
export interface SpatialAggregate {
  n: number;
  mean: number[];
  /** Sample std per bin (0 when n < 2). */
  std: number[];
}

/** Axis metadata for a spatial chart's X labels, resolved by the host
 *  (SimulatorView) from the indicator definition + live grid dims. */
export interface SpatialAxisMeta {
  axisName: string;   // 'row' | 'column' | 'layer'
  binSize: number;    // rows per bin (1 when unknown)
}

export type OverseerOutcome = 'completed' | 'stopped' | 'aborted' | 'error';

export interface OverseerDeps {
  getWorker: () => Worker | null;
  getActiveViewer: () => string;
  /** SimulatorView's end-condition evaluator (null = no condition met). */
  evalEndConditions: (gen: number, indicators: IndicatorMap) => string | null;
  /** Runtime-only model-attribute write (worker + panel UI — never the model). */
  setModelAttr: (attrId: string, value: number) => void;
  /** Runtime-only Lookup Table re-roll from a seed (worker only — never the
   *  model). Resolves the table's axes + value policy and posts updateLookupTable
   *  with the seeded fill. No-op for an unknown/non-lookupTable id. */
  randomizeTable: (tableId: string, seed: number, density: number) => void;
  /** Live-apply a preset. 'needs-reinit' = the preset would force a structural
   *  worker reinit (grid dims / boundary) — v1 journals + skips those. */
  loadPresetLive: (presetId: string) => 'ok' | 'needs-reinit' | 'not-found';
  /** Called by `ovResetBoard` right after the worker acked the reset. Restores the
   *  model's embedded board when the model's `resetRestoresBoard` flag is on (a
   *  data-backed landscape is not reproducible from Init Events, so without this a
   *  sweep would silently measure an empty world). RESOLVES only once the worker
   *  has acked the restore, so the experiment's next action sees the restored
   *  board. Returns whether anything was restored (for the journal); a model with
   *  the flag off / no board resolves immediately with false. */
  restoreBoardAfterReset: () => Promise<boolean>;
  screenshot: (label: string) => void;
  startRecording: () => void;
  stopRecording: () => Promise<void> | void;
  /** Snapshot of the current runtime model-attribute values (the live object
   *  handed to the driver as O.modelAttrs). */
  modelAttrsSnapshot: () => Record<string, number>;
  seedPolicy: 'none' | 'fixed' | 'sequential';
  baseSeed: number;
  /** Bumped on every journal/series/progress change (panel re-render). */
  onUpdate: () => void;
  onFinished: (outcome: OverseerOutcome, message?: string) => void;
}

/** Max generations per posted step batch — bounds Abort latency and keeps the
 *  progress line ticking. */
const OV_BATCH = 500;

interface PendingAck {
  reqId: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

export class OverseerRuntime {
  readonly journal: OverseerJournalEntry[] = [];
  readonly series = new Map<string, OverseerSeries>();
  readonly spatialSeries = new Map<string, OverseerSpatialSeries>();
  running = false;
  outcome: OverseerOutcome | null = null;
  /** Reset Board count — the "run" counter shown in the status line. */
  resets = 0;
  statusLine = '';

  private deps: OverseerDeps;
  private abortedFlag = false;
  private stopRequested = false;
  private startTime = 0;
  private lastGen = 0;
  private lastIndicators: IndicatorMap = {};
  private lastStopEvent: { message: string } | null = null;
  private seededSinceReset = false;
  private reqCounter = 0;
  private pending: PendingAck | null = null;
  private attachedWorker: Worker | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;
  private modelAttrs: Record<string, number> = {};

  constructor(deps: OverseerDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------------ public

  start(driverBody: string): void {
    if (this.running) return;
    const worker = this.deps.getWorker();
    if (!worker) {
      this.pushJournal('error', 'No simulation worker — cannot run the experiment.');
      this.deps.onFinished('error', 'No simulation worker');
      return;
    }
    this.running = true;
    this.outcome = null;
    this.startTime = performance.now();
    this.modelAttrs = { ...this.deps.modelAttrsSnapshot() };
    this.attachedWorker = worker;
    this.listener = (e: MessageEvent) => this.onWorkerMessage(e);
    worker.addEventListener('message', this.listener);
    this.pushJournal('milestone', 'Experiment started.');
    this.setStatus('starting…');

    let fn: (O: unknown) => Promise<void>;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor as
        new (...args: string[]) => (O: unknown) => Promise<void>;
      fn = new AsyncFunction('O', driverBody);
    } catch (e) {
      this.pushJournal('error', 'Driver failed to parse: ' + ((e as Error)?.message ?? String(e)));
      this.finish('error', 'Driver parse error');
      return;
    }

    fn(this.buildApi())
      .then(() => {
        if (this.abortedFlag) this.finish('aborted');
        else if (this.stopRequested) this.finish('stopped');
        else this.finish('completed');
      })
      .catch(e => {
        const msg = (e as Error)?.message ?? String(e);
        if (this.abortedFlag) { this.finish('aborted'); return; }
        this.pushJournal('error', 'Experiment failed: ' + msg);
        this.finish('error', msg);
      });
  }

  /** Abort the running experiment. Honoured within ≤ one step batch. */
  abort(reason?: string): void {
    if (!this.running || this.abortedFlag) return;
    this.abortedFlag = true;
    this.pushJournal('warn', 'Abort requested' + (reason ? ` (${reason})` : '') + '.');
    // Unblock a pending batch ack wait if the worker is being torn down — the
    // driver's next `if (O.aborted) return` ends the program.
    if (this.pending && this.deps.getWorker() !== this.attachedWorker) {
      const p = this.pending;
      this.pending = null;
      p.reject(new Error('aborted'));
    }
  }

  elapsedMs(): number {
    return this.running || this.outcome ? performance.now() - this.startTime : 0;
  }

  generationNow(): number { return this.lastGen; }

  /** Per-bin mean ± sample-σ across a spatial series' collected runs. Bins are
   *  aligned by index (same indicator + bin config ⇒ constant length; a
   *  defensive max-length union treats short runs as absent from the tail). */
  spatialAggregate(name: string): SpatialAggregate {
    const s = this.spatialSeries.get(name);
    const runs = s?.runs ?? [];
    const bins = runs.reduce((m, r) => Math.max(m, r.length), 0);
    const mean = new Array<number>(bins).fill(0);
    const std = new Array<number>(bins).fill(0);
    for (let b = 0; b < bins; b++) {
      let n = 0, sum = 0;
      for (const r of runs) if (b < r.length) { n++; sum += r[b]!; }
      const m = n > 0 ? sum / n : 0;
      mean[b] = m;
      if (n >= 2) {
        let sq = 0;
        for (const r of runs) if (b < r.length) sq += (r[b]! - m) * (r[b]! - m);
        std[b] = Math.sqrt(sq / (n - 1));
      }
    }
    return { n: runs.length, mean, std };
  }

  /** CSV export: scalar series as (series,run,bin='',value); spatial series as
   *  one row per (run, position bin). */
  exportSeriesCSV(): string {
    const lines = ['series,run,bin,value'];
    for (const [name, s] of this.series) {
      s.values.forEach((v, i) => lines.push(`${JSON.stringify(name)},${i},,${v}`));
    }
    for (const [name, s] of this.spatialSeries) {
      s.runs.forEach((r, runIdx) => {
        r.forEach((v, b) => lines.push(`${JSON.stringify(name)},${runIdx},${b},${v}`));
      });
    }
    return lines.join('\n');
  }

  /** JSON export of the full journal + series + stats + spatial aggregates. */
  exportJSON(): string {
    const seriesOut: Record<string, { scope: string; values: number[]; mean: number; std: number; count: number }> = {};
    for (const [name, s] of this.series) {
      seriesOut[name] = {
        scope: s.scope, values: s.values,
        mean: this.statOf(s.values, 'mean'), std: this.statOf(s.values, 'std'), count: s.values.length,
      };
    }
    const spatialOut: Record<string, { chart: string; indicatorId: string; category: string; runs: number[][]; aggregate: SpatialAggregate }> = {};
    for (const [name, s] of this.spatialSeries) {
      spatialOut[name] = { chart: s.chart, indicatorId: s.indicatorId, category: s.category, runs: s.runs, aggregate: this.spatialAggregate(name) };
    }
    return JSON.stringify({
      finishedAt: new Date().toISOString(),
      outcome: this.outcome,
      resets: this.resets,
      journal: this.journal,
      series: seriesOut,
      spatialSeries: spatialOut,
    }, null, 2);
  }

  // ------------------------------------------------------------ worker plumbing

  private onWorkerMessage(e: MessageEvent): void {
    const msg = e.data as { type?: string; reqId?: number; generation?: number; indicators?: IndicatorMap; message?: string };
    if (msg.type === 'stepped') {
      if (typeof msg.generation === 'number') this.lastGen = msg.generation;
      if (msg.indicators) this.lastIndicators = msg.indicators;
      if (this.pending && msg.reqId === this.pending.reqId) {
        const p = this.pending;
        this.pending = null;
        p.resolve();
      }
    } else if (msg.type === 'stopEvent') {
      this.lastStopEvent = { message: String(msg.message ?? 'Stop condition reached') };
    } else if (msg.type === 'error') {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.reject(new Error(String(msg.message ?? 'worker error')));
      }
    }
  }

  private post(msg: Record<string, unknown>): void {
    const w = this.deps.getWorker();
    if (!w || w !== this.attachedWorker) throw new Error('The simulation worker was replaced (model changed?) — experiment aborted.');
    w.postMessage(msg);
  }

  private awaitAck(reqId: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending = { reqId, resolve, reject };
    });
  }

  private nextTick(): Promise<void> {
    // One macrotask: a stopEvent posted by the worker right after its stepped
    // is already queued — this lets it deliver before we decide "no stop".
    return new Promise(r => setTimeout(r, 0));
  }

  private consumeStopEvent(): string | null {
    const s = this.lastStopEvent;
    this.lastStopEvent = null;
    return s?.message ?? null;
  }

  // ------------------------------------------------------------------ helpers

  private pushJournal(kind: OverseerJournalEntry['kind'], text: string): void {
    this.journal.push({ t: Math.round(this.elapsedMs()), gen: this.lastGen, kind, text });
    if (this.journal.length > 2000) this.journal.splice(0, this.journal.length - 2000);
    this.deps.onUpdate();
  }

  private setStatus(s: string): void {
    this.statusLine = s;
    this.deps.onUpdate();
  }

  private finish(outcome: OverseerOutcome, message?: string): void {
    if (!this.running) return;
    this.running = false;
    this.outcome = outcome;
    if (this.listener && this.attachedWorker) {
      this.attachedWorker.removeEventListener('message', this.listener);
    }
    this.listener = null;
    this.setStatus(outcome === 'completed' ? 'completed'
      : outcome === 'stopped' ? 'stopped by the graph'
      : outcome === 'aborted' ? 'aborted'
      : `error: ${message ?? ''}`);
    this.pushJournal('milestone', `Experiment ${outcome}${message && outcome === 'error' ? ` — ${message}` : ''}. ` +
      `${this.resets} run(s), ${Math.round(this.elapsedMs() / 100) / 10}s.`);
    this.deps.onFinished(outcome, message);
  }

  private statOf(values: number[], op: string): number {
    const n = values.length;
    if (op === 'count') return n;
    if (n === 0) return 0;
    switch (op) {
      case 'sum': return values.reduce((a, b) => a + b, 0);
      case 'mean': return values.reduce((a, b) => a + b, 0) / n;
      case 'min': return Math.min(...values);
      case 'max': return Math.max(...values);
      case 'median': {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = n >> 1;
        return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      }
      case 'std': case 'ci95': {
        if (n < 2) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / n;
        const var_ = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
        const std = Math.sqrt(var_);
        return op === 'std' ? std : 1.96 * std / Math.sqrt(n);
      }
      default: return 0;
    }
  }

  /** Advance the simulation `total` generations. Generation-target-driven (not
   *  batch-count-driven) so it is robust to the worker under-advancing a batch
   *  when a Stop Event breaks the worker's internal loop early — the next batch
   *  simply continues from `lastGen`. `haltOnStop` = Run Until Stop semantics
   *  (return the moment the detector fires / an End Condition trips); when false
   *  (a fixed-count Run Generations), a Stop Event does NOT halt the run — the
   *  fixed count runs in full, which is what an ensemble average at a fixed time
   *  point needs (Run Until Stop is the node for detector-gated running). */
  private async runBatches(total: number, haltOnStop: boolean): Promise<{ stopped: 0 | 1 | 2; message?: string }> {
    const targetGen = this.lastGen + total;
    while (this.lastGen < targetGen) {
      if (this.abortedFlag || this.stopRequested) return { stopped: 0 };
      const batch = Math.min(targetGen - this.lastGen, OV_BATCH);
      const reqId = ++this.reqCounter;
      const genBefore = this.lastGen;
      this.post({ type: 'step', count: batch, activeViewer: this.deps.getActiveViewer(), skipColorPass: false, reqId });
      await this.awaitAck(reqId);
      await this.nextTick();
      const stopMsg = this.consumeStopEvent();
      if (stopMsg !== null && haltOnStop) {
        this.pushJournal('text', `Stop event: “${stopMsg}” at gen ${this.lastGen}.`);
        return { stopped: 1, message: stopMsg };
      }
      if (haltOnStop) {
        const endReason = this.deps.evalEndConditions(this.lastGen, this.lastIndicators);
        if (endReason) {
          this.pushJournal('text', `End condition: ${endReason} at gen ${this.lastGen}.`);
          return { stopped: 2, message: endReason };
        }
      }
      // Stall guard: if a batch advances nothing (frozen grid / no step fn),
      // stop rather than spin forever.
      if (this.lastGen === genBefore) break;
      this.setStatus(`run ${this.resets || 1} · gen ${this.lastGen}`);
    }
    return { stopped: 0 };
  }

  private maybeAutoSeed(): void {
    if (this.deps.seedPolicy === 'none' || this.seededSinceReset) return;
    const seed = this.deps.seedPolicy === 'fixed'
      ? this.deps.baseSeed
      : this.deps.baseSeed + this.resets;
    this.post({ type: 'setRngSeed', seed: seed >>> 0 });
    this.pushJournal('text', `Auto-seed ${seed} (${this.deps.seedPolicy} policy).`);
  }

  // ------------------------------------------------------------------ the O API

  private buildApi(): unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const rt = this;
    const api = {
      modelAttrs: this.modelAttrs,
      initialSeed: (this.deps.baseSeed | 0) || 12345,
      get aborted(): boolean { return rt.abortedFlag || rt.stopRequested; },

      async reset(): Promise<void> {
        rt.maybeAutoSeed();
        const reqId = ++rt.reqCounter;
        rt.post({ type: 'reset', activeViewer: rt.deps.getActiveViewer(), reqId });
        await rt.awaitAck(reqId);
        await rt.nextTick();
        rt.consumeStopEvent();
        // The model may declare its embedded board as the INITIAL state (a data
        // -backed landscape the Init Events cannot regenerate). Restore it on top
        // of the reset, and WAIT for the worker's ack — the driver's next action
        // must not run against the freshly-reset board.
        if (await rt.deps.restoreBoardAfterReset()) rt.pushJournal('text', 'Saved board restored.');
        rt.seededSinceReset = false;
        rt.resets++;
        // Run-scoped series clear at each Reset Board.
        for (const s of rt.series.values()) { if (s.scope === 'run') s.values.length = 0; }
        rt.lastGen = 0;
        rt.setStatus(`run ${rt.resets} · gen 0`);
      },

      async run(gens: number): Promise<void> {
        const n = Math.max(0, Math.floor(gens));
        if (n === 0) return;
        // Fixed-count run: a Stop Event does NOT halt it (that's Run Until Stop).
        await rt.runBatches(n, false);
      },

      async runUntilStop(maxGens: number): Promise<{ atGeneration: number; stoppedBy: 0 | 1 | 2 }> {
        const cap = Math.max(1, Math.floor(maxGens));
        const startGen = rt.lastGen;
        let stoppedBy: 0 | 1 | 2 = 0;
        while (rt.lastGen - startGen < cap && !rt.abortedFlag && !rt.stopRequested) {
          const batch = Math.min(cap - (rt.lastGen - startGen), OV_BATCH);
          const before = rt.lastGen;
          const r = await rt.runBatches(batch, true);
          if (r.stopped !== 0) { stoppedBy = r.stopped; break; }
          if (rt.lastGen === before) break;  // stall guard
        }
        if (stoppedBy === 0) rt.pushJournal('text', `Run Until Stop hit the ${cap}-generation cap at gen ${rt.lastGen}.`);
        return { atGeneration: rt.lastGen, stoppedBy };
      },

      async setSeed(seed: number): Promise<void> {
        rt.post({ type: 'setRngSeed', seed: (seed | 0) >>> 0 });
        rt.seededSinceReset = true;
      },

      async setAttr(attrId: string, value: number): Promise<void> {
        if (!attrId) return;
        rt.deps.setModelAttr(attrId, value);
        rt.modelAttrs[attrId] = value;
      },

      async randomizeTable(tableId: string, seed: number, density: number): Promise<void> {
        if (!tableId) return;
        const s = (seed | 0) >>> 0;
        const d = Math.min(1, Math.max(0, Number(density) || 0));
        rt.deps.randomizeTable(tableId, s, d);
        rt.pushJournal('text', `Randomize table "${tableId}" — seed ${s}, density ${d}.`);
      },

      async loadPreset(presetId: string): Promise<void> {
        const r = rt.deps.loadPresetLive(presetId);
        if (r === 'ok') rt.pushJournal('text', 'Preset applied.');
        else if (r === 'needs-reinit') rt.pushJournal('warn', 'Preset skipped — it would resize the grid (structural reinit mid-experiment is not supported).');
        else rt.pushJournal('warn', 'Preset not found — skipped.');
        // Preset model-attr changes flow through the worker; refresh our live view.
        Object.assign(rt.modelAttrs, rt.deps.modelAttrsSnapshot());
      },

      indicator(id: string, category?: string): number {
        const v = rt.lastIndicators[id];
        if (typeof v === 'number') return v;
        if (v && typeof v === 'object') {
          if (category !== undefined && category !== '') {
            const c = (v as Record<string, number | number[]>)[category];
            return typeof c === 'number' ? c : 0;
          }
          return 0;
        }
        return 0;
      },

      generation(): number { return rt.lastGen; },

      sample(name: string, value: number, scope?: string): void {
        if (!name) return;
        let s = rt.series.get(name);
        if (!s) {
          s = { scope: scope === 'run' ? 'run' : 'experiment', values: [] };
          rt.series.set(name, s);
        }
        s.values.push(Number(value) || 0);
        rt.deps.onUpdate();
      },

      stat(name: string, op: string): number {
        const s = rt.series.get(name);
        return rt.statOf(s?.values ?? [], op);
      },

      clearSeries(name: string): void {
        const s = rt.series.get(name);
        if (s) { s.values.length = 0; rt.deps.onUpdate(); }
        const sp = rt.spatialSeries.get(name);
        if (sp) { sp.runs.length = 0; rt.deps.onUpdate(); }
      },

      /** Collect Spatial Sample — capture a spatial indicator's current
       *  per-position-bin curve (one category) as ONE run of a spatial series.
       *  Aggregated to mean ± σ in the Experiments panel + exports. */
      sampleSpatial(name: string, indicatorId: string, category: string, chart: string): void {
        if (!name) return;
        const v = rt.lastIndicators[indicatorId];
        if (!v || typeof v !== 'object') {
          rt.pushJournal('warn', `Collect Spatial Sample: indicator has no spatial value yet (series “${name}”).`);
          return;
        }
        const map = v as Record<string, number | number[]>;
        let key = category;
        if (!key) {
          // Single-key maps (e.g. a Total spatial indicator's 'total') need no
          // explicit category.
          const keys = Object.keys(map).filter(k => Array.isArray(map[k]));
          if (keys.length === 1) key = keys[0]!;
        }
        const curve = map[key];
        if (!Array.isArray(curve)) {
          rt.pushJournal('warn', `Collect Spatial Sample: category “${key || '(unset)'}” not found on the indicator (series “${name}”).`);
          return;
        }
        let sp = rt.spatialSeries.get(name);
        if (!sp) {
          sp = { chart: chart || name, indicatorId, category: key, runs: [] };
          rt.spatialSeries.set(name, sp);
        }
        sp.runs.push([...curve]);
        rt.deps.onUpdate();
      },

      log(text: string): void { rt.pushJournal('text', text); },

      logT(template: string, value: number | undefined): void {
        const text = (template || '{value}')
          .split('{value}').join(value === undefined ? '' : String(Math.round(value * 1e6) / 1e6))
          .split('{gen}').join(String(rt.lastGen));
        rt.pushJournal('text', text);
      },

      stopExperiment(message: string): void {
        rt.stopRequested = true;
        rt.pushJournal('milestone', message || 'Experiment stopped by the graph.');
      },

      async screenshot(label: string): Promise<void> {
        rt.deps.screenshot(label);
        rt.pushJournal('text', `Screenshot “${label}” captured (downloaded).`);
      },

      async startRecording(): Promise<void> {
        rt.deps.startRecording();
        rt.pushJournal('text', 'Recording started.');
      },

      async stopRecording(): Promise<void> {
        await rt.deps.stopRecording();
        rt.pushJournal('text', 'Recording stopped (encoding + download).');
      },

      linspace(from: number, to: number, steps: number): number[] {
        const n = Math.max(1, Math.floor(steps));
        if (n === 1) return [from];
        const out = new Array<number>(n);
        for (let i = 0; i < n; i++) out[i] = from + (i * (to - from)) / (n - 1);
        return out;
      },

      trace(_nodeId: string): void { /* debug hook — no-op in v1 */ },
    };
    return api;
  }
}

# PLAN — The Overseer: a third graph for experiment orchestration

**Status: PROPOSAL / BRAINSTORM — nothing implemented.** This document is a comprehensive, handoff-ready plan.
Companion illustrated version: [PLAN_OVERSEER.html](PLAN_OVERSEER.html) (self-contained, inline SVG diagrams).
Authored 2026-07-11 on branch `sim_agent_fixes`. No code changes accompany this commit.

---

## 1. Summary

GenesisCA models today define WHAT happens inside a simulation: the **Cells graph** (per-cell rules) and the
**Agents graph** (per-agent rules). The **Overseer** is a proposed third graph that defines what happens
**around and across simulations**: it is the experiment protocol. Its nodes reset/prepare the board, set
parameters, run N generations (or run until a stop condition), read indicators, collect samples, aggregate
statistics, capture screenshots/recordings, and loop — so that a *set of executions* becomes a single,
reproducible, automated experiment whose output is an actual scientific result (mean ± std across replicates,
a sweep curve, an evolved parameter set) rather than one anecdotal run.

Motivating scenarios (all from real usage patterns of the shipped models):

1. **Statistical replication** — a stochastic model (Chromatography, Amphiphile) is only meaningful in
   aggregate: repeat the run 30× with different seeds, collect "generation at which S1 eluted", report
   mean ± std. Today this is 30 manual runs and a spreadsheet.
2. **Parameter sweeps** — "how does `gravity` affect separation?": for each value in {1, 2, 5, 10}, run K
   replicates, chart the response. Today this is presets + manual bookkeeping.
3. **Compound / factorial experiments** — vary two or more parameters jointly (weather-model style),
   producing a response surface.
4. **Protocol automation** — experiments that need mid-run intervention: prepare the column, run 500
   generations, inject the solute band (a board write at gen 500), keep running until the detector fires.
   Today the InitEvent covers gen 0 only; everything later is manual brushing.
5. **Evolutionary algorithms** — treat a parameter vector as a genome: evaluate fitness from indicators,
   select, mutate/crossover, repeat. The Overseer's loops + parameter writes + measurements are exactly the
   required primitives.
6. **Unattended capture** — "record a WebM of run 3 of the sweep", "screenshot the board every 100
   generations" as part of the protocol, not as a human hovering over the transport bar.

**One sentence:** the Cells/Agents graphs are the physics; the Overseer is the scientist.

---

## 2. Positioning — the three-tier execution model

| Tier | Graph | Runs | Tempo | Compile targets |
|---|---|---|---|---|
| Per-cell | Cells graph | once per cell per generation (up to 25M×/gen) | ns–µs | JS / WASM / WebGPU |
| Per-agent | Agents graph | once per agent per generation (up to ~10k×/gen) | µs | JS / WASM / WebGPU |
| Per-experiment | **Overseer graph** | a few node evaluations per run / batch | ms–s (dominated by awaited simulation time) | driver (async JS) — see §4.1 |

The key structural insight: **the Overseer is not a compile-target consumer at all — it is the driver that
CALLS the simulation.** It sits where `SimulatorView`'s play pipeline sits today (issue a step batch → await
the `stepped` message → decide what to do next), except the decisions are authored in a graph instead of
hardcoded UI handlers. The CA itself continues to run on whichever compile target the model selects
(JS/WASM/WebGPU, grid + agents) — the Overseer merely orchestrates via the existing worker protocol, exactly
like the transport bar does. This is the same posture as the agent colour pass ("JS on the worker regardless
of the agent compile target"): orchestration code that executes a handful of times per second is not hot-path
per-cell code, so the ALL-TARGET DELIVERY rule is satisfied by construction — the simulation keeps its three
targets; there is no per-cell work in the Overseer to port.

**Relation to existing features** (the Overseer generalizes, none are removed):

- **End Conditions** (`ModelProperties.endConditions`, evaluated in `SimulatorView.evalEndConditions`,
  [SimulatorView.tsx:2383](../src/simulator/SimulatorView.tsx)) — remain the simple per-run auto-pause. The
  Overseer's `Run Until Stop` node *consumes* the same signals (stop events + end conditions) as loop-exit
  conditions.
- **Stop Event node** (cell + agent graphs) — unchanged; becomes an inter-tier signal: the inner simulation
  raises it, the Overseer reacts to it.
- **Presets** (`CAModel.presets`) — unchanged; the Overseer gets a `Load Preset` node so a protocol can start
  from a named configuration.
- **InitEvent / Agent Init Event** — unchanged (gen-0 procedural setup); the Overseer's board-setup nodes
  cover *any later time* (scenario 4).
- **Indicators** — unchanged and load-bearing: **indicators are the measurement layer**; the Overseer reads
  them rather than re-implementing grid scans (decision D-OV-4).

---

## 3. Model definition changes (schema)

All additive & optional — old `.gcaproj` files load unchanged; no migration required beyond the standard
`LOAD_MODEL` seed guards.

```ts
// src/model/types.ts
interface CAModel {
  // ... existing ...
  overseerGraphNodes?: GraphNode[];   // mirrors agentGraphNodes (types.ts:947)
  overseerGraphEdges?: GraphEdge[];
  overseerVariables?: Variable[];     // experiment-scoped mutable state (mirrors agentVariables)
  overseerConfig?: OverseerConfig;
}

interface OverseerConfig {
  enabled: boolean;                   // Properties → Execution checkbox gates the whole feature
  seedPolicy?: 'fixed' | 'sequential' | 'random';  // per-run auto-seed when the graph doesn't set one
  baseSeed?: number;                  // for fixed/sequential
  maxSnapshotSlots?: number;          // memory guard for Save/Load Snapshot (default 4)
  maxParallelRuns?: number;           // worker-pool ceiling (PR4; default 1 = sequential)
}
```

Notes:

- The **graph serialization rides `stringifyCompact`** exactly like `agentGraphNodes` (one line per
  node/edge) — [fileOperations.ts](../src/model/fileOperations.ts) needs only the two new keys in the
  compact-inline list.
- `macroDefs` stays **shared** across all three graphs (same as Cells/Agents today), with availability
  gating deciding which macros make sense per graph (see §7, gotcha 12).
- **Experiment RESULTS are deliberately NOT schema** (decision D-OV-6): sample series, journal entries,
  captures are runtime artifacts exported to CSV/JSON/PNG/WebM — embedding them in `.gcaproj` would bloat
  files (the existing thumbnail/simulationState size lessons) and confuse "model definition" with "one
  particular run's output".
- The **Model Structure list in CLAUDE.md §"The GenesisCA Model Definition"** gains item 6:
  *"6. Overseer (optional) — a graph defining experiment orchestration: how executions are prepared,
  repeated, measured, and aggregated."*

---

## 4. Core architecture decisions

Each decision is numbered for handoff reference; alternatives were considered and the rejection reasons are
recorded so a future session doesn't re-litigate them.

### D-OV-1 — The Overseer runtime lives on the MAIN THREAD and drives the worker via the existing message protocol

A new `OverseerRuntime` module (main thread, owned by/adjacent to `SimulatorView`) executes the compiled
experiment program. Every action maps to an **existing, verified worker message**:

| Overseer action | Worker message (all already exist) |
|---|---|
| Reset board | `reset` ([sim.worker.ts:266/4766](../src/simulator/engine/sim.worker.ts)) |
| Run N generations | `step {count}` (the play pipeline's batch message) |
| Set model attribute | `updateModelAttrs` (275/5127) |
| Set RNG seed | `setRngSeed` (306 — exists today, DEV-only by convention; **promoted to a supported message**, see D-OV-5) |
| Apply image to board | `importImage` (276/5175 — already has optional `region`) |
| Save/Load snapshot slot | `getState` / `loadState` (304/5470, 308/5526) |
| Read indicators | already ride every `stepped` message |
| Detect stop | `stopEvent` message (worker posts at 4492/4535/4576; SimulatorView handles at 2710) |
| Screenshot / recording | main-thread paths (`handleScreenshot` :6452, `startRecording` :6203, `setRecording` worker msg :368) — refactored into callable functions |

**Why main thread, not in-worker:** (a) capture (screenshots, GIF/WebM encoding, `SpriteRegistry`-style
decode) is main-thread; (b) the multi-run worker POOL (PR4) must live outside any single worker; (c) progress
UI and abort need the main thread anyway; (d) zero new hot-path code — the worker's step loop is untouched.
**Rejected alternative — run the Overseer inside the sim worker:** would duplicate capture plumbing into the
worker, couples the experiment to one grid instance (kills parallel replicates), and saves nothing (the
per-message overhead is negligible at experiment tempo).

### D-OV-2 — Compile to an async JS driver function; reuse per-node JS `compile()` for pure value nodes

`compileOverseerGraph(nodes, edges, model)` (new file `src/modeler/vpl/compiler/overseer/compile.ts`) emits a
single **async** function via `new Function`, taking one parameter `O` — the runtime API object:

```js
// what the compiler emits for: Loop(20) → [SetSeed, Reset, Run(200), ReadIndicator→CollectSample] ; then Stat+Log
(async function experiment(O) {
  const _modelAttrs = O.modelAttrs;             // live view for reused getModelAttribute emits
  for (let _l1 = 0; _l1 < 20; _l1++) {          // Loop node (existing universal node)
    await O.setSeed(1000 + _l1);                // Set Random Seed
    await O.reset();                            // Reset Board
    await O.run(200);                           // Run Generations
    const _v12 = O.indicator('ind_alive');      // Read Indicator (freq category support built in)
    O.sample('aliveAt200', _v12);               // Collect Sample
    if (O.aborted) return;                      // injected at loop back-edges + after every await
  }
  O.log(`alive@200 = ${O.stat('aliveAt200','mean').toFixed(2)} ± ${O.stat('aliveAt200','std').toFixed(2)} (n=${O.stat('aliveAt200','count')})`);
})
```

- **Front-end pipeline is the standard one**: `expandMacros → collapseReroutes → expandMultiAttrs (where
  applicable) → canonicalizeAccessorEdges` — the Overseer graph is flat and tiny afterwards.
- **Flow emit is a NEW, small emitter** (sequence/conditional/loop/forEach/switch + the Overseer action
  nodes → `await O.x(...)` lines). It must follow the established flow-walk rules (walk `next`
  pass-through ports; dynamic `case_N`/`then_N` ports via the edge map, not `def.ports`).
- **Value emit REUSES the existing per-node JS `compile()`** for the allowed universal value nodes
  (arithmetic, expression, compare, logic, constants, random, proportionMap, interpolation, valueSwitch,
  array element/length, aggregate-over-array, getModelAttribute). Their emitted strings are context-free
  scalar expressions (or reference `_modelAttrs`, which the driver provides — see the emit above), so
  semantics stay in lockstep with the Cells/Agents compilers with zero duplication.
- **Rejected alternative — a graph interpreter:** simpler for v1 and would give free live node highlighting,
  but re-implements the semantics of ~30 universal value nodes (silent drift risk vs the compilers — the
  exact bug class the shared-lowering architecture exists to prevent). Live highlighting is still cheap under
  the compiler approach: emit optional `O.trace(nodeId)` calls when a debug flag is set (experiment tempo
  makes the overhead irrelevant). If the async emitter turns out hairy, the interpreter remains a documented
  fallback — but start with the compiler.
- **RNG note:** `getRandom` on the Overseer graph compiles to the *driver's* RNG (`O.rng()` —
  a seedable xorshift32 owned by the runtime, independent from the sim worker's stream), so experiment-level
  randomness (e.g., EA mutation) is reproducible under the experiment seed and never perturbs the
  simulation's stream.

### D-OV-3 — A third `ActiveGraphKind`; the editor swap machinery is reused wholesale

`ActiveGraphKind` ([graphState.ts:57](../src/modeler/vpl/graphState.ts)) becomes `'cells' | 'agents' |
'overseer'`. Everything follows the pattern the Agents graph established:

- `SET_OVERSEER_GRAPH` reducer + `setOverseerGraph` callback (mirror `SET_AGENT_GRAPH`,
  [ModelContext.tsx:227/1053/1816](../src/model/ModelContext.tsx) — wire the callback into BOTH `useMemo`
  dep arrays).
- GraphEditor: third pill in the Cells/Agents strip (shown only when `overseerConfig.enabled`); the
  scope-switch effect forks its root branch + initial seed on `activeGraph`; `scheduleSync` routes root edits
  to the right SET_* action; `flushSync` before swap; clipboard graph-kind tag gains `'overseer'`
  (cross-graph paste rejected, with the disabled "Paste (from X graph)" affordance).
- Palette / quick-add / connection-drop gating via `getActiveGraphKind()` in
  [nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts) `isNodeAvailable` (see §5 for the
  allowlist decision).
- Singleton enforcement: the `experiment` root joins `SINGLETON_NODE_TYPES`.
- The Attributes panel's graph-awareness (`ownAttrList`, `tagAttrScope`) gains an overseer arm: on the
  Overseer graph there is no "own attribute" (no per-cell/per-agent context) — the own-attribute accessor
  family is simply not available there (allowlist), so no new resolution scope is needed beyond model attrs.

### D-OV-4 — Measurements flow through INDICATORS; the Overseer does not scan the grid

The Overseer reads what indicators already compute (frequency maps, totals, standalone scalars — including
their accumulated modes). Rationale: indicators are the existing, 3-target-verified measurement layer (JS
embed / WASM worker fallback / WebGPU reductions), they already ride every `stepped` message, and
"measure X" experiments should improve the shared layer rather than fork a second one. An escape hatch
(`Get Grid State` → raw arrays) is explicitly deferred (v3+, if ever) — every scenario in §1 is expressible
via indicators + stop events.

### D-OV-5 — First-class, reproducible seeding

Statistical work is meaningless without seed control. The plan promotes `setRngSeed`
([sim.worker.ts:306](../src/simulator/engine/sim.worker.ts) — currently "DEV-only, never sent by the app")
to a supported message, adds a `Set Random Seed` Overseer node, and adds the per-run auto-seed policy
(`OverseerConfig.seedPolicy`: fixed / sequential (base+runIndex) / random). Documented caveat (existing
stance, unchanged): JS/WASM share the xorshift32 stream (bit-reproducible per seed); WebGPU uses per-cell PCG
(statistically equivalent, not bit-equal across targets). Replicate statistics are therefore
**within-target reproducible** — which is what an experiment needs.

### D-OV-6 — Results are runtime artifacts: Journal + Series, exported, never embedded in the model

- **Series** — named sample vectors (`O.sample(name, value)`); names are plain strings from node config (no
  schema-level registry in v1). Scope: `run` (cleared each run) or `experiment` (accumulates). Stats:
  mean/std (Welford), min/max/median/sum/count/ci95 (t-based).
- **Journal** — an ordered log of `{time, runIdx, generation, kind: text|image|table|video, payload}`.
  Screenshots/recordings append journal entries with download affordances.
- **Export** — CSV per series, JSON for the full journal + all series. Nothing written into `.gcaproj`.

### D-OV-7 — Parameter writes are RUNTIME-ONLY (match the simulator sliders, not the model file)

`Set Model Attribute` behaves like the right-panel sliders: write the worker (`updateModelAttrs`) + reflect
in the panel UI state — never dispatch a model edit (no `isDirty`, no `.gcaproj` change, no recompile). An
experiment that sweeps `gravity` leaves the model definition untouched. (Lookup-table cell writes via
`updateLookupTable` are a v2 node under the same posture.)

### D-OV-8 — Parallel replicates are PHASED IN (v1 sequential + visible; PR4 adds a headless worker pool)

v1 runs sequentially on the ONE visible worker — every run is watchable, capture works, and the runtime is
simple. PR4 adds a pool of headless sim workers (each `init`-ed with the same compiled payload the visible
worker got) for embarrassingly-parallel replicates; the visible worker doubles as "watch run #k". Capture
nodes remain valid only on the watched run (validation-badged otherwise). Determinism: each pooled run gets
its policy seed; runs are independent by construction (separate workers, separate memories).

### D-OV-9 — Evolutionary algorithms: PRIMITIVES FIRST; dedicated EA nodes only if proven necessary

The EA loop is expressible with what this plan already provides: overseer variables/series hold the
population (arrays of parameter values), `getRandom` + expression nodes implement mutation/selection,
`Set Model Attribute` applies a genome, `Run Until Stop` + `Read Indicator` evaluate fitness. PR5 ships an
**EA sample model + a reusable "EA Generation" macro** built from primitives. Dedicated nodes
(`Init Population`, `Tournament Select`, `Mutate`, `Crossover`) are added only if the sample proves the
primitive wiring too clumsy — this mirrors how `SampleArrayByWeight` was folded into
`GroupOperator.weightedRandom` (primitives beat single-purpose nodes unless demonstrated otherwise).

---

## 5. Node catalogue

New nodes carry `requirements: { overseer: true }` (a new `NodeRequirements` flag, same mechanism as
`bondGraph`). **Availability on the Overseer graph is an explicit ALLOWLIST**, not a blocklist: most
universal nodes assume a per-cell/per-agent context (`setCellLooks`, `getCellAttribute`, neighbour access…)
and must NOT appear there. `OVERSEER_UNIVERSAL_TYPES` in nodeValidation.ts enumerates the shared nodes that
are meaningful at experiment tempo.

### 5.1 Event root (1)

| Node | Kind | Ports | Notes |
|---|---|---|---|
| **Experiment** (`experiment`) | event root, white | flow out `DO` | singleton; the only Overseer entry point in v1. Future roots (v3+): `On Run End`, `On Stop Event` hooks. |

### 5.2 Run control (flow)

| Node | Config / inputs | Semantics |
|---|---|---|
| **Reset Board** (`ovResetBoard`) | — | Full Reset semantics: defaults + cell InitEvent + agent init, gen→0, indicators re-init. Worker `reset`. |
| **Run Generations** (`ovRunGenerations`) | input `count` (int, inline) | Advance N generations (internally batched; await). |
| **Run Until Stop** (`ovRunUntilStop`) | input `maxGens` (safety cap, inline default 100000) | Run until a Stop Event fires, an End Condition trips, or the cap is hit. Value outs: `atGeneration` (int), `stoppedBy` (0=cap, 1=stopEvent, 2=endCondition), `stopIndex` (which Stop Event, 1-based; 0 otherwise). |
| **Load Preset** (`ovLoadPreset`) | config `presetId` | Reuses the `handleLoadPreset` logic ([SimulatorView.tsx:6599](../src/simulator/SimulatorView.tsx)) — live param apply vs structural reinit, same predicate. |
| **Save Snapshot** (`ovSaveSnapshot`) | config `slot` (name) | `getState` → in-memory slot (cap `maxSnapshotSlots`; size-warned on huge grids). |
| **Load Snapshot** (`ovLoadSnapshot`) | config `slot` | `loadState` from the slot. NOTE: existing loadState semantics (gen→0, indicators re-init) — documented; a "continue generation counter" option is v3+. |
| **Set Random Seed** (`ovSetSeed`) | input `seed` (int) | Worker `setRngSeed` (D-OV-5). |
| **Stop Experiment** (`ovStopExperiment`) | input/config `message` | Ends the experiment program; journal-logged. |

### 5.3 Board setup (flow)

| Node | Config / inputs | Semantics |
|---|---|---|
| **Apply Image** (`ovApplyImage`) | config: embedded image (data URL, ≤2 MB like thumbnails), `mappingId` (or manual-sets mode), placement (resize-grid / paste-centered), region/anchor | Reuses `gridifyImage` ([imageMapping.ts](../src/simulator/imageMapping.ts)) + worker `importImage` (which already supports `region` + the WebGPU `patchWebGPUCells` path). 2D-only in v1 (same limitation as the dialog). |
| **Write Region** (`ovWriteRegion`) *(v2)* | inputs `row`,`col`,`w`,`h`; config: per-attribute sets (ManualBrush-style mini panel) | Worker `writeRegion` + `paintManual` machinery; the scenario-4 "inject the solute band at gen 500" primitive. |

### 5.4 Parameters (flow + value)

| Node | Config / inputs | Semantics |
|---|---|---|
| **Set Model Attribute** (`ovSetModelAttribute`) | config `attributeId` (model attrs; type-adaptive inline value widget), input `value` | Runtime-only write (D-OV-7). Color model attrs: three inputs r/g/b (v2). |
| **Get Model Attribute** | *(reused universal node)* | Works verbatim — the driver provides `_modelAttrs` (see D-OV-2 emit). |
| **Set Lookup Table Cell** *(v2)* | config table + row/col keys, input `value` | Worker `updateLookupTable` (per D-OV-7 posture). |

### 5.5 Measurement (value)

| Node | Config / inputs | Semantics |
|---|---|---|
| **Read Indicator** (`ovReadIndicator`) | config `indicatorId` (+ `category` for freq maps, mirroring End Conditions' category support) | Latest value from the last `stepped` message. Spatial indicators excluded in v1 (like End Conditions). |
| **Get Generation** (`ovGetGeneration`) | — | Current generation of the (watched) run. |
| **Get Run Index** (`ovGetRunIndex`) | — | 0 in v1 (sequential); the pooled-run index under PR4. Useful for seeds/labels before PR4 via loop indices anyway. |
| **Get Agent Count** *(v2)* | — | `liveCount` from the agent snapshot. |

### 5.6 Data & statistics

| Node | Kind | Config / inputs | Semantics |
|---|---|---|---|
| **Collect Sample** (`ovCollectSample`) | flow | config `series` (string), `scope` (run/experiment); input `value` | Append to the named series. |
| **Series Statistic** (`ovSeriesStat`) | value | config `series`, `op` (mean/std/min/max/median/sum/count/ci95) | Scalar over the current series contents. |
| **Series Values** (`ovSeriesValues`) *(v2)* | value (array out) | config `series` | The series as an array — feeds `forEachInArray` / `aggregate` for custom post-processing. |
| **Clear Series** (`ovClearSeries`) | flow | config `series` | Reset a series (e.g., between sweep points). |
| **Sweep Values** (`ovSweepValues`) | value (array out) | config: mode `linspace` (from/to/steps) or explicit list | The canonical sweep driver: wire into `forEachInArray`. |

### 5.7 Capture & journal (flow)

| Node | Config / inputs | Semantics |
|---|---|---|
| **Log Message** (`ovLog`) | config `text` template; optional `value` input(s) | Journal text entry (`{gen}`, `{run}`, `{value}` placeholders). |
| **Take Screenshot** (`ovScreenshot`) | config `label` | Calls the extracted screenshot path; journal thumbnail + download. |
| **Start Recording** (`ovStartRecording`) / **Stop Recording** (`ovStopRecording`) | config format gif/webm | Wrap the extracted recording paths; the blob becomes a journal entry. Valid only on the watched run (validation badge under PR4 pooling). |

### 5.8 Reused universal nodes (the `OVERSEER_UNIVERSAL_TYPES` allowlist)

Flow: `sequence`, `conditional`, `loop`, `forEachInArray`, `switch`.
Value: `getConstant` (number/bool/tag*), `arithmeticOperator`, `expression`, `statement` (Compare),
`logicOperator`, `getRandom` (driver RNG — see D-OV-2), `valueSwitch`, `proportionMap`, `interpolation`,
`arrayElement`, `arrayLength`, `aggregate` (array-source mode), `getModelAttribute`.
Variables: `getVariable` / `setVariable` / `setArrayElement` over **`overseerVariables`** (experiment-scoped;
declared once per experiment run, reset at experiment start — the natural `let` in the driver function).
\* tag constants resolve against model attrs' tag options (the only discrete scope visible at this tier).

**Explicitly NOT available on the Overseer graph:** every per-cell/per-agent node — own-attribute accessors,
neighbour/NI family, setCellLooks, indicators' `setIndicator`/`updateIndicator` (the sim writes indicators;
the Overseer only reads), all `bondGraph` nodes, orientation/variegation, Stop Event (the *cell/agent* node —
the Overseer has `ovStopExperiment` instead).

Estimated catalogue delta: **~20 new node types** (v1 ships ~14 of them), each in its own file under
`src/modeler/vpl/nodes/overseer/` (or flat with the `ov` prefix), registered in
[registry.ts](../src/modeler/vpl/nodes/registry.ts) with `description` fields, `detectMissingConfig` cases
for every required config (presetId, series, attributeId, indicatorId, slot, image).

---

## 6. Runtime design (`src/simulator/engine/overseerRuntime.ts` + SimulatorView wiring)

### 6.1 Lifecycle

```
[Run Experiment button]
  → SimulatorView pauses normal play, compiles overseer graph (or reuses cached compile)
  → new OverseerRuntime({ worker, captureApi, indicatorFeed, modelAttrsApi, journal, seriesStore, config })
  → runtime executes the async driver fn
      each O.run(n): posts step batches (bounded size, e.g. ≤ gensPerFrame equivalent), awaits `stepped`,
                     updates progress UI, honours abort between batches
      each O.reset()/O.setSeed()/…: posts the mapped message, awaits its ack/next stepped where applicable
  → on completion / ovStopExperiment / abort / error: journal a terminal entry, restore normal transport
```

- **Message correlation:** worker messages are FIFO per worker, but the runtime must not confuse
  overseer-issued `stepped` acks with residual play-pipeline messages. Add an optional `reqId` (number)
  echoed on `stepped` (and on `getState`'s reply) — a tiny additive worker change; all other consumers
  ignore it.
- **Abort:** the worker has no mid-batch cancel; the runtime bounds batch sizes so abort latency ≈ one batch.
  `O.aborted` checks are injected after every `await` and at loop back-edges (see the D-OV-2 emit).
- **Tab-hidden behaviour:** SimulatorView auto-pauses the PLAY loop when hidden; the Overseer drives steps
  itself, so experiments CONTINUE while hidden (deliberate — long batches shouldn't require babysitting).
  Draw work is already skipped while hidden; capture nodes force a draw for their frame.
- **Recompile/model-edit interplay:** any event that reinits or soft-recompiles the worker
  (`needsFullInit`, `recompile`) while an experiment is running **aborts the experiment** with a journal
  notice. Same for loading another model. (`beforeunload` already guards the page itself.)
- **Snapshot slots:** stored as the `getState` payload (typed arrays). Budget check at save time:
  `bytes ≈ total × Σ attrBytes`; over ~256 MB aggregate → journal warning + refuse (config-capped count).

### 6.2 The `O` API surface (v1)

```ts
interface OverseerApi {
  // awaited actions
  reset(): Promise<void>;
  run(gens: number): Promise<void>;
  runUntilStop(maxGens: number): Promise<{ atGeneration: number; stoppedBy: 0|1|2; stopIndex: number }>;
  setSeed(seed: number): Promise<void>;
  setAttr(attrId: string, value: number): Promise<void>;
  loadPreset(presetId: string): Promise<void>;
  saveSnapshot(slot: string): Promise<void>;
  loadSnapshot(slot: string): Promise<void>;
  applyImage(cfg: ApplyImageCfg): Promise<void>;
  screenshot(label: string): Promise<void>;
  startRecording(fmt: 'gif'|'webm'): Promise<void>;
  stopRecording(): Promise<void>;
  // sync reads / stores
  indicator(id: string, category?: string): number;
  generation(): number;
  runIndex(): number;
  modelAttrs: Record<string, number>;      // live view (getModelAttribute reuse)
  sample(series: string, v: number): void;
  stat(series: string, op: StatOp): number;
  clearSeries(series: string): void;
  log(text: string): void;
  rng(): number;                            // seedable driver RNG (experiment-level randomness)
  trace(nodeId: string): void;              // debug highlight hook (no-op unless enabled)
  aborted: boolean;
}
```

### 6.3 Experiment panel (Simulator UI, v1)

A new right-panel section (or collapsible panel following the Layers/Agents pattern):

- **Run Experiment / Abort** buttons + status line (`run 7/20 · gen 143/200 · elapsed 0:41`).
- **Journal** — scrolling list (text lines, screenshot thumbnails, table entries); autoscroll; Clear.
- **Series table** — per series: n, mean, std, min, max (live), with a chart toggle reusing the existing
  canvas chart components (sparkline for a series; mean±CI bars per sweep group in PR3).
- **Export** — CSV (per series), JSON (journal + series).
- All overlay elements carry `data-sim-overlay` (existing brush-guard convention).

---

## 7. Subsystem impact map

(The Impact-Map-First convention: this section is the subsystem-by-subsystem map; PR0 may lift it into a
standalone `docs/IMPACT_MAP_OVERSEER.md` if it grows during implementation.)

| # | Subsystem | Impact | Risk |
|---|---|---|---|
| 1 | [types.ts](../src/model/types.ts) | +4 optional CAModel fields; `NodeRequirements.overseer`; `OverseerConfig` | Low (additive) |
| 2 | [ModelContext.tsx](../src/model/ModelContext.tsx) | `SET_OVERSEER_GRAPH` + callback (both dep arrays!); LOAD_MODEL seed guards; cleanup cascades (`patchAllNodes` must scan `overseerGraphNodes` — the same `_undef`-strand class the Agents graph hit); variable actions gain `target:'overseer'` | Medium — the cascade scan is the known foot-gun |
| 3 | [fileOperations.ts](../src/model/fileOperations.ts) | compact-inline the two new arrays | Low |
| 4 | [GraphEditor.tsx](../src/modeler/vpl/GraphEditor.tsx) + [graphState.ts](../src/modeler/vpl/graphState.ts) | third `ActiveGraphKind`; pill strip; scope-switch fork; scheduleSync routing; clipboard tag; singleton root | Medium — every `activeGraph === 'agents' ? … : …` two-way branch must become three-way (sweep for binary assumptions) |
| 5 | [nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts) | `OVERSEER_UNIVERSAL_TYPES` allowlist; `requirements.overseer` gate; `detectMissingConfig` cases for ~14 new nodes | Medium — allowlist correctness IS the safety boundary |
| 6 | [registry.ts](../src/modeler/vpl/nodes/registry.ts) + new node files | ~14 (v1) new defs | Low, mechanical |
| 7 | New `compiler/overseer/compile.ts` | async flow emitter + value-node reuse + `O.trace` hooks | Medium — flow-walk rules (`next`, dynamic ports) must be honoured from day one |
| 8 | [SimulatorView.tsx](../src/simulator/SimulatorView.tsx) | Experiment panel; extract screenshot/recording into callable fns; OverseerRuntime ownership; abort-on-reinit wiring; play-pipeline mutual exclusion (experiment running ⇒ transport disabled) | **High — the file is the giant; keep the runtime in its own module and the panel lean** |
| 9 | [sim.worker.ts](../src/simulator/engine/sim.worker.ts) | optional `reqId` echo on `stepped`/`getState`; promote `setRngSeed` to supported; NO step-loop changes | Low |
| 10 | Dev harness ([compileHarness.ts](../src/dev/compileHarness.ts)) | `compileAll` gains `overseer.driverCode`; byte-identity checks: non-overseer models unchanged on all 3 targets | Low |
| 11 | Docs (CLAUDE.md, HelpView, README, NODES_REFERENCE) | Model-definition list +1; new node section; node-count updates; Help chapter "Running Experiments" | Low but mandatory (docs-consistency rule) |
| 12 | Macros | shared `macroDefs`; availability gating means a macro built from lattice nodes is un-placeable on the Overseer graph — needs the same "macro contains unavailable nodes" badge path used today | Low |
| 13 | 2D/3D dual impact | Overseer is dimension-agnostic (drives the worker protocol); `ovApplyImage` is 2D-only v1 (badge in 3D, mirroring the dialog's gate); snapshot slots already 3D-correct via `getState` depth | Low |
| 14 | All-target rule | No per-cell emit at all; the simulation keeps JS/WASM/WebGPU. Explicitly documented posture (§2) | — |

**What is deliberately NOT touched:** the cell/agent step loops, all six compilers' hot paths, the grid SoA,
the agent engine, indicator computation, save/load of existing fields. A model with `overseerConfig` absent
must be **byte-identical end-to-end** (compile output + runtime behaviour) — this is the standing regression
bar for every PR below.

---

## 8. Phased delivery

Each PR is independently shippable, keeps `master` green (`npx tsc -b` + `npm run build` + dev-harness
byte-identity on non-overseer models), and ends with the listed verification.

### PR0 — Scaffolding (schema + third graph tab; no runtime)
Schema fields + LOAD_MODEL guards; `SET_OVERSEER_GRAPH`; third pill + swap + clipboard tag; Properties →
Execution "Overseer (Experiments)" checkbox; `experiment` root placeable (singleton); allowlist gating
active; `.gcaproj` round-trip.
**Verify:** three-graph swap in-app; save/load round-trips the overseer graph; ALL existing library models
compile byte-identical on 3 targets (harness sweep); clipboard cross-graph paste rejected.

### PR1 — Walking skeleton: the statistics loop
Overseer compiler (root, sequence/conditional/loop/forEach + `ovResetBoard`, `ovRunGenerations`, `ovSetSeed`,
`ovSetModelAttribute`, `ovReadIndicator`, `ovCollectSample`, `ovSeriesStat`, `ovLog` + universal value
subset); `OverseerRuntime` (run/abort, reqId correlation, batch-bounded stepping); Experiment panel v1
(status, journal, series table, CSV export); seed policy; `setRngSeed` promotion.
**Verify:** the canonical experiment — *20 × (seed→reset→run 200 gens of GoL→collect alive-count) →
mean±std* — runs unattended on JS, WASM AND WebGPU compile targets; abort mid-run leaves the app healthy;
tab-hidden continuation; re-running gives identical numbers under a fixed seed policy (JS/WASM).

### PR2 — Protocol depth: until-stop, board prep, capture
`ovRunUntilStop` (+ stop/end-condition plumbing), `ovLoadPreset`, `ovApplyImage`, snapshot slots,
`ovScreenshot`/`ovStartRecording`/`ovStopRecording`, `ovStopExperiment`, `ovWriteRegion`.
**Verify:** the Chromatography batch sample (§9) end-to-end — 30 replicates of run-until-detector, elution
generation mean±std, one WebM of the first run; snapshot save/load round-trip mid-protocol.

### PR3 — Sweeps & result charts
`ovSweepValues`, grouped series (series named per sweep value or a group key), mean±CI chart (reuse the
canvas chart components + `dataviz` conventions), JSON export, `ovSeriesValues`, overseer variables.
**Verify:** the Gravity-vs-Separation sweep sample produces a monotone response curve matching the paper's
Table 4 direction; chart renders in light/dark.

### PR4 — Parallel replicates (worker pool)
Headless worker pool (same init payload), per-run seeds, watch-run selector, capture-node gating,
progress aggregation.
**Verify:** pool of 4 reproduces PR1's sequential statistics (same seed policy ⇒ same per-run numbers,
JS/WASM); wall-clock scales ~linearly for 4 replicates; UI stays responsive.

### PR5 — Evolutionary algorithms
EA sample + "EA Generation" macro from primitives (population in overseer array variables, tournament
selection via driver RNG, gaussian mutation via expression nodes, fitness from indicators); decide on
dedicated EA nodes ONLY after the sample exists (D-OV-9).
**Verify:** the EA sample improves its fitness metric monotonically-ish over ≥20 generations of evolution on
a fixed seed; the journal shows per-generation best/mean fitness; result parameters reproducible.

---

## 9. Sample models to ship (the proof of usefulness)

1. **GoL Replicate Statistics** (PR1) — the tutorial: 20 seeds × 200 gens, alive-count mean±std. Small,
   fast, teaches the loop-collect-aggregate idiom.
2. **Chromatography Batch** (PR2) — the headline: N replicates of the existing Chromatography model, each
   run-until-detector (its Stop Event already exists), collect elution generation + final separation
   (S1/S2 mean-row indicators), aggregate, record one run. Directly reproduces the paper's
   "average of 30 runs" methodology that single runs can't.
3. **Gravity vs Separation Sweep** (PR3) — sweep `gravity` over Table-4-like values × K replicates each,
   chart the response.
4. **EA — Evolve Separation** (PR5) — evolve PB/J parameters to maximize S1–S2 separation at elution;
   or (alternative) evolve a GoL soup density for maximum lifetime. Pick whichever demos better.

---

## 10. Risks & gotchas (numbered for handoff)

1. **SimulatorView sprawl** — the runtime must be its own module; the panel its own component. Do not add
   another 1000 lines to SimulatorView.
2. **Binary graph-kind assumptions** — sweep every `activeGraph`/`ActiveGraphKind` consumer for
   two-way branches before adding the third value (GraphEditor, palette, Attributes panel, NodeExplorer,
   modelerUiState snapshot, clipboard).
3. **Cleanup cascades** — every `patchAllNodes`/`clearDeletedId` site must scan `overseerGraphNodes`
   (deleting an indicator/preset/model-attr must clear overseer node configs; the Agents graph shipped this
   bug class once already).
4. **Message correlation** — without `reqId`, a residual play-pipeline `stepped` can be mistaken for an
   overseer batch ack. Add the echo first, not after the first heisenbug.
5. **Abort latency** — bound step batches (e.g. ≤2000 gens per message or the WebGPU stop-check interval,
   whichever is smaller) so Abort feels immediate.
6. **Capture perf rules** — reuse the extracted screenshot/recording paths verbatim; never `getImageData` a
   live canvas (the documented 6× de-opt); recordings exclude the cursor layer by construction.
7. **Snapshot memory** — `getState` payloads on a 5000² grid are ~hundreds of MB; enforce the slot budget
   and journal-warn instead of OOMing.
8. **Run-until-stop on WebGPU** — stop-flag checks happen every `webgpuStopCheckInterval` generations; the
   runtime must tolerate overshoot within a batch (report the actual stop generation from the message, not
   the request).
9. **Indicator freshness** — indicators ride `stepped`; after `reset` the runtime must await the post-reset
   paint/step message before `O.indicator()` reads, or values are stale (define: reads are only valid after
   ≥1 run/reset ack; compiler orders naturally since reads are wired downstream).
10. **Determinism** — document per-target RNG stance (D-OV-5); auto-seed BEFORE InitEvent randomization
    (the reset must apply the seed first — worker orders `setRngSeed` ahead of `reset` in the runtime).
11. **Universal-node leakage** — the allowlist is the safety boundary; a per-cell node on the Overseer graph
    must be impossible to place (gate) and badged if hand-edited into a file (validation).
12. **Macro availability** — a macro whose internals use non-allowlisted nodes must be un-placeable on the
    Overseer graph (reuse the existing macro-internals scan).
13. **Long-run UX** — progress must tick every batch; the `beforeunload` guard already exists; consider
    keep-awake later (out of scope v1).
14. **Docs drift** — CLAUDE.md + HelpView + README + NODES_REFERENCE updates are part of EVERY PR's
    definition of done (standing rule).

---

## 11. Open decisions (need user input before/during PR0)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Name: "Overseer" everywhere, or "Overseer" graph + "Experiments" panel label? | Keep **Overseer** for the graph/fundamental; panel titled **Experiments** (user-facing verb). |
| Q2 | v1 catalogue trim OK (§5, ~14 nodes; WriteRegion/Sweep charts later)? | Yes — walking skeleton first (PR1 list). |
| Q3 | Compiler-with-reuse vs interpreter (D-OV-2)? | Compiler-with-reuse; interpreter only as fallback. |
| Q4 | Parameter writes runtime-only (D-OV-7)? | Yes — matches slider semantics. |
| Q5 | Parallel pool priority — PR4 as listed, or pull earlier? | As listed; sequential v1 already delivers the statistics win. |
| Q6 | EA: primitives-first (D-OV-9)? | Yes; decide dedicated nodes after the PR5 sample. |
| Q7 | Should `ovApplyImage` embed the image in node config vs a shared model-level image-asset library? | Embed in config v1 (thumbnail-style, ≤2 MB); asset library only if multiple nodes share images. |
| Q8 | Where does the Experiment panel live — right-panel section vs its own top-level simulator tab? | Right-panel section v1 (pattern-consistent); revisit if the journal needs space. |

---

## 12. Handoff notes

- **This commit contains only** `docs/PLAN_OVERSEER.md` + `docs/PLAN_OVERSEER.html`. No implementation.
- Branch at authoring time: `sim_agent_fixes` (clean tree otherwise). The Overseer work itself should start
  on a fresh feature branch off `master` once greenlit (e.g. `overseer`), per the branching convention.
- Verified code anchors used above (re-check before relying on line numbers — they drift):
  `graphState.ts:57` (ActiveGraphKind), `ModelContext.tsx:227/1053/1816` (SET_AGENT_GRAPH pattern),
  `types.ts:947` (agentGraphNodes), `sim.worker.ts:266/275/276/304/306/308/368` (message interfaces) +
  `4766/5127/5175/5470/5526/4965` (handlers) + `4492/4535/4576` (stopEvent posts),
  `SimulatorView.tsx:2383` (evalEndConditions), `:2710` (stopEvent handler), `:6203/6452/6599`
  (startRecording/handleScreenshot/handleLoadPreset).
- Standing rules that bind every Overseer PR: ALL-TARGET posture per §2/§7-14, 2D+3D dual impact,
  docs consistency, pre-commit `npx tsc -b`, illustrated plans for UI changes, no counter-based IDs,
  worker `WorkerMsg` union updates for any new message.

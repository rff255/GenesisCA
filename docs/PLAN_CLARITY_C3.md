# PLAN — C3: fast-path diagnostics popover (P4 rest) + generated capability docs (P8)

Illustrated mockup: [PLAN_CLARITY_C3.html](PLAN_CLARITY_C3.html).
Runbook: [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md) §C3.
Proposal items: P4 (fast-path diagnostics + loud fallbacks) and P8 (docs generated from
the gate tables).

---

## 1. What problem this closes

C1 made **Class S / R / C** inspectable before running (the Compatibility readout) and
C2 made the **generation shape** inspectable (the Pipeline panel). Both describe what the
model *asks for*.

**Class F — fast-path eligibility — is still folklore.** Whether GPU residency, sparse
stepping, direct render or the E1b field bridge actually engaged is decided by ~8-term
runtime predicates inside the worker. Probes exist (`__e1bCounters`, `sieActive`,
`agentRenderStatus`) but they are DEV-only and un-discoverable, so "is my model on the fast
path?" is unanswerable from the UI. Worse, when a fast path *silently degrades at runtime*
(WASM instantiate failure, GPU device loss, a per-step GPU bail, a hash-overflow fallback)
the evidence is a console line the user never sees.

C3 makes the RUNTIME half inspectable, and generates the capability/limits documentation
from the enforcing tables so it cannot drift.

**C2 describes what the model asks for; C3 reports what actually engaged.** They are a pair.

---

## 2. Deliverable 1 — the `getDiagnostics` worker message

### 2.1 Protocol (additive; nothing existing changes)

```ts
// main → worker
{ type: 'getDiagnostics' }

// worker → main
{ type: 'diagnostics',
  residency:    { eligible, engaged, firstBlocker?: string },
  sparse:       { configured, active, count },
  fieldBridge:  { eligible, gpuGens, cpuGens },
  directRender: { mode: 'off' | 'grid-direct' | 'agent-direct' | 'composite' | 'voxel' },
  engine:       { grid, agents, fallbackEvents: string[] } }
```

Requested **on demand only** (when the popover opens, plus a light poll while it is open) —
never per step. `verify-agent-render.mjs` must stay green: this is a new case in the message
switch, no existing message shape is touched.

### 2.2 Sourced from EXISTING worker state

| Field | Source |
|---|---|
| `residency.eligible` | `agentResidentEligible()` (already exists) |
| `residency.firstBlocker` | **`residencyModelBlockers(...)[0].text`** — C1's shared predicate, the SAME call `agentResidentEligible` makes |
| `residency.engaged` | a new counter bumped where `runAgentBatchResident` actually succeeds |
| `sparse.configured` | `sieParamsPresent` |
| `sparse.active` / `count` | the SAME expression `sendColors` computes for the `sieActive` field on `stepped` — extracted to one helper so the popover and the ◩ chip cannot disagree |
| `fieldBridge.*` | `agentFieldBridgeGpuEligible()` + `e1bGpuBridgeGenCount` / `e1bCpuBridgeFallbackCount` |
| `directRender.mode` | `agentCompositeActive` / `agentRenderActive` / `voxelRenderOn()` / `webgpuRuntime.directRender` |
| `engine.grid` / `engine.agents` | `useWebGPU` / `useWasm` / `agentTarget` (the worker's RESOLVED values, incl. its safety-net demotions) |
| `engine.fallbackEvents` | the new `runtimeEvents` log (below) |

The residency blocker is deliberately taken from the shared predicate rather than
re-derived: C1's report leaves exactly this follow-up — *the UI approximates the residency
facts from node types; C3 should feed the real worker/compiler flags*. The worker knows
`rt.usesSpawn` / `rt.usesStop` / `rt.indicatorsBuf` / `s.maxBonds` **as allocated**, so its
answer is the truth and it wins in this popover.

### 2.3 The `runtimeEvents` log

A capped module-level array (`RUNTIME_EVENT_CAP = 40`, oldest dropped) appended at every
currently-silent fallback site:

| Site | Rate-limit |
|---|---|
| `[wasm] instantiate failed` (grid) | once per instantiate attempt |
| `[wasm] compile failed` (grid, init + recompile) | per occurrence |
| `[agents] WASM instantiate failed` | per occurrence |
| `[agents] WASM layout mismatch → JS` | per occurrence |
| `[agents] WASM behaviour / force pass threw → JS` | per occurrence |
| `[agents] WebGPU runtime build failed → JS` | per occurrence |
| `[agents] WebGPU step failed → JS` | per occurrence |
| **spatial-hash overflow (WASM reserve)** | **once** (reuses the existing `agentWasmHashOverflowWarned` latch) |
| **spatial-hash overflow (GPU reserve)** | **once** (reuses `agentWebgpuHashOverflowWarned`) |
| `[webgpu] grid init/compile failed` — every `webgpuGridFailed = true` site, **including the two that post nothing today** | per occurrence |
| **shared GPU device lost / uncaptured error** | device-loss once; uncaptured errors capped at 3 |

Each entry is `{ t: generation, text }`. Entries are recorded **in addition to** whatever
the site already posts — the `error` message is transient (a banner), the log persists so
the popover can answer "did anything degrade during this run?" after the banner is gone.

**The shared-device hooks live in `sharedGpuDevice.ts`**, which must not import the worker
(it is imported BY it). It therefore gains an optional `setSharedGpuEventSink(fn)` the
worker installs — a one-line seam, no new dependency direction.

### 2.4 Zero simulation-behaviour change

Every edit is either (a) a push into an array, (b) a counter increment, or (c) a new
message case. No predicate, no resolver, no emit surface is touched.
`check-compile-identity --compare` must report all 29 models byte-identical.

---

## 3. Deliverable 2 — the diagnostics popover

Anchored on the **simulator compile-target chip** (`⚙ WASM · agents WebGPU`), which C1
already made amber-on-demotion. Click opens; the FPS / G-F / capture popovers already use
a single-open `overlayPopup` state, so `'diagnostics'` joins that union and inherits the
one-at-a-time behaviour, the capture-phase outside-pointerdown dismissal and Escape for
free.

Three sections:

**ENGINE** — one row per layer: `CA grid — WebAssembly`, `Agents — WebGPU`. A demoted layer
is amber with `requested X → running Y` and the classified reason (C1's `demotionReason`).

**FAST PATHS** — one row each, `engaged` (green) or `off — <first blocking reason>` (grey):

| Row | Engaged when |
|---|---|
| GPU residency | `residency.engaged` (a batch actually ran resident) |
| Sparse stepping | `sparse.active` |
| GPU field bridge | `fieldBridge.gpuGens > 0` |
| Direct render | `directRender.mode !== 'off'` |

Rows are **never red and never an error** — Principle 3 is restated in the section
footnote: *speed paths are eligibility, not correctness.*

**EVENTS** — the `runtimeEvents` list, newest first, with the generation each occurred at;
`No runtime fallbacks this session.` when empty. Amber, because every entry means the
engine is running something other than what was asked for.

**Runtime truth wins here.** Where the worker's real flags disagree with C1's static
node-type approximation (e.g. a Create Agent that is reachable only from the Init Event),
the popover shows the worker's answer — that is the point of the message.

### 3.1 Layout / interaction rules (from the capture-cluster lessons)

- The chip gets its OWN `position: relative` wrapper so the popover anchors to the chip,
  not to the whole stats strip.
- Opens **upward-left, flush** (`bottom: 100%; right: 0`, no gap — a visual gap is a
  hit-test hole).
- Opens on **click** (not hover): the stats strip is a passive readout and a hover popover
  there would fire constantly while the user reaches for the transport bar.
- Everything stays inside the existing `data-sim-overlay` wrapper, so a click can never
  fall through and paint cells.
- `max-height` + `overflow-y` so a long event list cannot exceed a short canvas.

---

## 4. Deliverable 3 — P8, generated capability docs

### 4.1 `scripts/gen-capability-docs.mjs` → `src/help/capabilityMatrix.gen.ts`

Node-only, following the repo's established esbuild-bundle pattern for importing TS
sources (exactly how `check-compile-identity.mjs` and `test-generation-pipeline.mjs` do it).
Emits a **committed** TS module so HelpView imports plain data with no build-time magic.

Generated content, all from the REAL tables:

1. **Agent node → capability** — from `AGENT_NODE_REQUIREMENT`, joined with the registry
   for display labels.
2. **Per-target agent reject deltas** — **COMPUTED**, never hand-listed:
   `registry agent nodes − AGENT_WASM_SUPPORTED_TYPES` and
   `registry agent nodes − AGENT_WEBGPU_SUPPORTED_TYPES`. If a node is added to the
   catalogue and forgotten in a supported set, the generated doc says so on the next run.
3. **The WebGPU grid reject set** — the documented fundamentals, read from the enforcing
   code's own sets where they are exported, else recorded with an explicit source note.
4. **Capacity constants** — `AGENT_NEARBY_SCRATCH_SLOTS`, `AGENT_WEBGPU_NEARBY_SLOTS`,
   `AGENT_GPU_ARRAY_CAP`, the bond-request queue depth + clamp, and the other named
   limits, each with its value and one-line meaning.
5. Counts (total nodes, agent nodes, per-target support totals) so the Help prose stops
   carrying hand-typed numbers that go stale.

### 4.2 `--check` mode

Regenerates in memory and diffs against the committed file; exits non-zero when stale, so
"someone added a node and the docs are now wrong" is a gate failure rather than a silent
drift. This is the P8 point: *hand-maintained tables are how the current drift happened.*

### 4.3 HelpView consumes it

The hand-written capability/limits fragments are deleted and replaced by a component that
renders the generated module — the same integration shape C2 used for
`GenerationPipelineReference`.

`docs/NODES_REFERENCE.md` per-node annotations are **explicitly out of scope this phase**
(the runbook scopes P8 here to the Help matrix); the generator is structured so a future
phase can emit that table from the same data.

---

## 5. Verification plan

Gates: `tsc`, `npm run build`, `check-compile-identity --compare` (29 models byte-identical),
`parity-agent-wasm`, `check-agent-wasm-gate`, `verify-agent-render`,
`gen-capability-docs --check`.

In-browser (real models, real worker messages):

| Case | Expectation |
|---|---|
| Boids — Flocking, WebGPU agents | residency **engaged** |
| Morphogenesis — Growing Tissue, WebGPU agents | residency **off**, first blocker names the structural/bond reason |
| Accretor | sparse row count **equals** the `◩ N active` stats chip |
| A forced fallback (DEV hook) | the event is logged, appears in the popover, and is **one-time** where the site is rate-limited |

---

## 6. Non-goals (explicit)

- No toast surfacing of fallback events — that is **C6** (the runbook assigns the UI half of
  loud fallbacks there; C3 builds the log C6 consumes).
- No engine or resolver change of any kind.
- No `NODES_REFERENCE.md` regeneration (see §4.3).

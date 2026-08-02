# PLAN — C4: One **Engine** selector (`Auto | WebAssembly | WebGPU` + Debug JS)

Implements **P1** of [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md),
phase **C4** of [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md).
Illustrated mockup: [PLAN_CLARITY_C4.html](PLAN_CLARITY_C4.html).

**One sentence**: the user declares an **intent** (`Auto`) or an **engine**; ONE pure
function resolves that intent to the engine that will actually run, and everything —
the radio, the compile paths, the compatibility readout, the chip, the worker — reads
that one answer.

---

## 1. The problem this closes

Today the grid engine is TWO booleans (`useWasm`, `useWebGPU`) that must be kept mutually
exclusive by the UI, with a worker-side safety net for hand-edited files that set both.
The agent engine is a separate three-value enum. Neither has an "I don't care, pick the
fast one" option, so **the library's own compile-target policy — "WebGPU where the gates
pass, else WASM" — is applied by hand, per model, and is invisible to the user**. And JS
sits in the list as a peer of the production engines even though it exists to be the
readable reference, not a runtime choice.

---

## 2. Schema (additive; legacy files behave byte-identically)

```ts
type EngineChoice = 'auto' | 'wasm' | 'webgpu' | 'js';

ModelProperties.engine?: EngineChoice          // absent ⇒ derived from the legacy flags
CenterBasedConfig.agentTarget?: 'auto' | 'js' | 'wasm' | 'webgpu'   // 'auto' is new
```

**`useWasm` / `useWebGPU` are NOT deleted.** They become the **resolved mirror** — the
representation every existing consumer already reads (the worker init message, the WASM /
WebGPU layout builders, `detectWebGPU*Incompatibilities`, the CaNode badge). Keeping them
is what makes this phase byte-identical *and* keeps older builds able to open new files
(the one-release back-compat window the runbook asks for).

### Migration — `src/model/engineFieldMigration.ts`

`migrateEngineField(model)`, wired into `LOAD_MODEL` and `migrateForHarness`:

| file has | `engine` becomes |
|---|---|
| `useWebGPU: true` | `'webgpu'` |
| else `useWasm: true` | `'wasm'` |
| else | `'js'` |

i.e. **the EXPLICIT equivalent of what the file already does** — a legacy file never
becomes `auto`. The mapping is exactly `gridRequestedEngine` from C1 (WebGPU wins when a
hand-edited file sets both, mirroring the worker's safety net). `agentTarget` is left
untouched (absent ⇒ the historical `'js'` resolution). Idempotent: a file that already
carries `engine` is returned unchanged, same object reference.

`macroImport` is **not** a site: a `.gcamacro` carries a `MacroDef`, which has no
`properties` and no `centerBased` — there is nothing to migrate.

### Defaults

`EMPTY_MODEL`: `engine: 'auto'` (keeps `useWasm: true` as the static mirror — see §4).
`defaultCenterBasedConfig()`: `agentTarget: 'auto'`.

---

## 3. Resolution — `src/model/engineResolution.ts` (the single source)

```ts
resolveEngines(model) → {
  grid:    { selected, requested, resolved, reason, auto },
  agents?: { selected, requested, resolved, reason, auto },   // only when agents are on
}
```

- **`selected`** — what the user picked (may be `'auto'`).
- **`requested`** — the engine that selection asks for (for `auto`, its pick).
- **`resolved`** — what will actually run, after the real gates demote.
- **`reason`** — a sentence for the UI. Always set for `auto`; set on a demotion otherwise.

**Auto policy this phase** (C5 replaces it with the reproducibility contract):

| layer | policy |
|---|---|
| grid | `overseerConfig.enabled` ⇒ **WASM** (sweep reproducibility) · else WebGPU when every grid gate passes · else WASM |
| agents | `overseerConfig.enabled` ⇒ WASM when the WASM gate passes, else JS · else WebGPU when its gate passes · else WASM when its gate passes · else JS |

Every verdict comes from the **real gate** — `detectWebGPUModelIncompatibilities`,
`detectWebGPUIncompatibilities`, `isAgentGraphWasmSupported`,
`isAgentGraphWebGPUSupported`, `agentTargetOf`. Nothing is re-derived (the C1 discipline).

`resolveEngines` is **memoised on the model object** (WeakMap): the reducer creates a new
model object per edit, so this is one evaluation per model version, shared by every caller
(including the per-node CaNode badge, which would otherwise be O(N²)).

**A note on the new-model outcome** — the runbook's verification bullet expects
*"a New model shows Auto → WebAssembly"*, but the policy sentence in BOTH the proposal and
the runbook is "WebGPU where every gate passes, else WASM", and an empty synchronous grid
passes every gate. C5 then states explicitly that *"the GRID stays WebGPU-eligible under
exact"*, so resolving a new model to WASM here would be contradicted next phase. **The
policy wins**; a new model shows **Auto → WebGPU**. Recorded as a deviation.

### Baking — `withResolvedEngine(model)`

Materialises the resolution into the mirror:

- grid → `useWasm` / `useWebGPU` for the **`requested`** engine
  (NOT `resolved` — see below),
- agents → `centerBased.agentTarget` set to the concrete `requested` target.

Returns the **same object reference** when nothing changes, so memoisation and effect deps
are untouched.

> **Why `requested` and not `resolved`**: for an EXPLICIT choice, baking the demoted engine
> would stop SimulatorView from compiling the requested target — and it is that compile's
> ERROR that produces today's user-visible message and C3's fallback event (C3 verified
> exactly this on an async model with WebGPU selected). Auto never picks a failing engine,
> so for `auto` requested ≡ resolved and the distinction does not arise.

Applied in SimulatorView at the three places that build the model handed to the compilers
and the worker (init, soft recompile, Show Code), and inside `serializeModel` so a saved
file's mirror always matches the live resolution.

---

## 4. Where each consumer reads from

| consumer | reads |
|---|---|
| SimulatorView init / recompile / `compileAgentModel` | `withResolvedEngine(model)` → the existing flags (unchanged downstream) |
| `needsFullInit` | the RESOLVED flags, so an `auto` model that re-resolves after a graph edit reinitialises |
| Simulator chip | C3 `getDiagnostics.engine.grid/agents` when the worker has replied, else `resolveEngines` (the model-side prediction) |
| C1 `diagnoseTargets` | `resolveEngines` for `selected/requested/resolved`; keeps its own reason texts |
| CaNode validation badge | `resolveEngines(model).grid.resolved` (badges describe the engine that will run) |
| `serializeModel` | bakes the mirror before writing |
| worker | unchanged — it receives concrete flags / a concrete `agentTarget` |

`agentTargetOf` gains an `'auto'` arm (webgpu → wasm → js by gate) purely as the
**file-load safety net** for a config that somehow reaches the engine un-baked; the
model-level policy (including the Overseer preference, which needs the model) stays in
`resolveEngines`.

---

## 5. UI

**Properties → Execution → Engine** (renamed from "Compile Target"):

```
Engine                                        [Auto → WebGPU]
( ) Auto  (recommended)
    Picks the fastest engine this model can use, and re-picks as you edit.
( ) WebAssembly            ( ) WebGPU (sync only)
▸ Advanced
    ( ) Debug / Reference (JS) — readable & breakpointable, slow
```

- The **Auto badge** shows the live resolution + the reason underneath.
- The **Advanced reveal** is collapsed by default and auto-opens when JS is the current
  selection (otherwise the selected option would be invisible).
- The agent radio gets the identical treatment ("Agent Engine").

**Show Code** always renders the **JS reference source**, with a header note naming the
engine that actually runs. The WebGPU compile still runs when WebGPU is resolved (its
error must keep surfacing) — only the *displayed text* changes.

---

## 6. Gate — `scripts/test-engine-resolve.mjs`

Over **every** `public/models/*.gcaproj` plus synthetic cases:

1. **Migration reproduces the legacy resolution** — `engine` after migration maps back to
   exactly the file's original `useWasm`/`useWebGPU`, and `withResolvedEngine` restores
   those same flags (the byte-identity argument, model by model).
2. `agentTarget` is untouched by migration; the resolved agent target equals
   `agentTargetOf(cfg, wasmGate, webgpuGate)` — the pre-change answer.
3. **New-model Auto expectations** — sync/empty ⇒ WebGPU; async ⇒ WASM; Overseer ⇒ WASM;
   agents auto over a WebGPU-supported / WASM-only / JS-only graph.
4. **Save → load round-trip** — `serializeModel` → parse → migrate: `engine` and the
   mirror survive.
5. **An OLD-shape file (no `engine`) loads identically** to what it did before.
6. **Negative controls** — deliberately wrong mappings must be caught.

---

## 7. Out of scope (named, not silently dropped)

- The **reproducibility contract** and its Auto integration — **C5**.
- Deleting the legacy flags — one release cycle of back-compat first; the removal
  schedule is documented in CLAUDE.md.
- A WGSL **shader inspector**: Show Code becomes JS-only per spec, so the emitted shader
  is no longer reachable from the UI (it remains available through the dev harness).
  Re-adding it as an Advanced read-only view is a possible follow-up.

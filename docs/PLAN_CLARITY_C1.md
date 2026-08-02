# PLAN — C1: Target Compatibility readout (P2) + resolved-config annotations (P4 core)

Phase C1 of [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md).
Implements [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md) **P2** +
the **P4 core**. Illustrated mockup: [PLAN_CLARITY_C1.html](PLAN_CLARITY_C1.html).

**READ-ONLY PHASE — zero behaviour change.** Nothing here alters an emit surface, a
worker decision, or a stored model. `check-compile-identity` must report every library
model byte-identical on every surface. The only worker edit is an *import swap*: two
inline formulas become calls to shared pure helpers that compute the same numbers.

---

## 1. The problem, in one sentence

Every restriction the user meets is one of four classes — **S**emantics, **R**eproducibility,
**F**ast-path, **C**apacity — and the UI presents them all as an undifferentiated "X doesn't
work on Y", *after* the fact, in a console warning. So "bonds prevent WebGPU" (false) and
"bonds forfeit GPU residency" (true) are indistinguishable.

C1 makes the verdict **visible before running**, **classified**, and **computed by the same
functions that enforce it** so it cannot drift.

---

## 2. Deliverables

### 2.1 `src/model/agentResidency.ts` (new, pure) — the shared residency terms

`agentResidentEligible()` in the worker mixes MODEL-derivable terms (config + graph facts)
with RUNTIME-only terms (`rt.ready`, `simulateAgents`, the resolved target). The UI needs
the first group; the worker owns the second.

```ts
export interface ResidencyGraphFacts {
  residencyClean: boolean;      // !usesStructural && !usesRadiusWrite (compiler-scoped)
  usesField: boolean;           // a field node reachable in the agent graph
  hasAgentAccessibleField: boolean;   // a cell attr grants agent access
  usesSpawn: boolean; usesStop: boolean; usesIndicators: boolean;
  hasStopMessages: boolean;
}
export function residencyModelBlockers(cfg, facts): ResidencyBlocker[]
```

**The worker consumes it** (`agentResidentEligible` keeps only its runtime terms and calls
this for the rest), so the readout and the engine can never disagree — the
`resolveMaxBonds` / `modelAttrSlotKeys` single-source discipline. The worker does NOT get
imported into the main thread; both import the helper.

Ordering note: the blocker list is returned **ordered by how fundamental the term is**
(structural rewriting first, capacity/plumbing last) so a UI showing only the first
reason shows the most explanatory one.

### 2.2 `effectiveAgentDt(cfg)` in `centerBased.ts`

`clampAgentDt()` is worker-local:

```
muEff = max(1e-6, repulsionStiffness + bondStiffness)
dt    = min(timeStep, 0.2 / muEff)
```

Extracted verbatim to `effectiveAgentDt(cfg) → { requested, dt, muEff, clamped }`. The
worker's `clampAgentDt` becomes `agentStore.dt = effectiveAgentDt(cfg).dt` — the same
arithmetic on the same inputs in the same order, so the engine is byte-identical.

### 2.3 `capabilityClosureDrivers(profile)` in `agentCapabilities.ts`

**Derived, never hand-written.** For each capability J that is ON in the resolved profile,
close a baseline profile containing ONLY J and record which OTHER capabilities the closure
turns on — those are the ones J requires. Invert that map to get, per row, the list of
drivers. If `computeCapabilityClosure` changes, the annotations follow automatically.

### 2.4 `src/model/targetDiagnosis.ts` (new, pure) — `diagnoseTargets(model)`

```ts
type ReasonClass = 'semantics' | 'reproducibility' | 'fastpath' | 'capacity';
interface Reason { class: ReasonClass; text: string }
interface EngineVerdict { engine: 'js'|'wasm'|'webgpu'; ok: boolean; blockers: Reason[]; notes: Reason[] }
interface LayerDiagnosis { layer: 'grid'|'agents'; present: boolean; requested; resolved; verdicts: EngineVerdict[] }
diagnoseTargets(model) → { layers: LayerDiagnosis[] }
```

Every verdict CALLS the real gate:

| Verdict | Real gate called |
|---|---|
| grid / webgpu — async mode | `detectWebGPUModelIncompatibilities` (on a `useWebGPU:true` probe clone) |
| grid / webgpu — node rejects | `detectWebGPUIncompatibilities` per node, macro-aware walk |
| agents / wasm | `isAgentGraphWasmSupported` |
| agents / webgpu | `isAgentGraphWebGPUSupported` |
| resolved agent target | `agentTargetOf(cfg, wasmSupported, webgpuSupported)` |
| residency note | `residencyModelBlockers` (§2.1) |
| bonds/store | `resolveMaxBonds` |

**A gate that only answers for the CURRENTLY-selected target is asked hypothetically** by
handing it a shallow probe clone with that target selected — the honest way to answer
"could I use WebGPU?" without duplicating the gate's logic.

Statistical-parity notes (f32 + per-agent PCG) attach to every `webgpu` verdict as a
class-**R** note, never a blocker. Fast-path notes are class **F**, never blockers.

### 2.5 UI — Properties → Execution → **Compatibility** (collapsible)

A `CollapsibleSection id="compatibility"` (the existing pattern, persisted collapse state)
rendering one block per present layer:

```
CA GRID                                   requested: WebAssembly
  ✓ WebAssembly    exact, seedable
  ✗ WebGPU         [S] This model is Asynchronous — a write must be visible to a
                       later cell in the same generation. The GPU runs cells in
                       parallel, so sequential semantics cannot be expressed.
  ✓ Debug (JS)     reference semantics

AGENTS                                    requested: WebGPU → running WebGPU
  ✓ WebAssembly    exact, seedable (bit-parity with JS)
  ✓ WebGPU         [R] Statistical parity — f32 math + per-agent RNG …
                   [F] Not GPU-residency eligible: the model forms bonds …
  ✓ Debug (JS)     reference semantics
```

- Class tag chips `S` / `R` / `F` / `C`, colour-keyed (S red, R blue, F grey, C amber).
- A one-line doctrine footer linking the three principles (Help).
- Rows are read-only; the radios stay where they are.

### 2.6 UI — P4 annotations

1. **Effective Δt** — under the Time Step row, when `clamped`:
   `→ effective Δt 0.0625 (clamped from 0.1 for stability: μ_eff = 3.2)`.
2. **Capability closure "why"** — a `(required by Collision)` suffix on any row the closure
   forced on, from §2.3.
3. **Simulator target chip** — amber for EVERY `resolved ≠ requested` state (today only a
   failed WebGPU grid device turns amber; a gate-clamped agent target is silently normal),
   with the reasons in the tooltip.

---

## 3. What this phase does NOT do

- No engine/emit change, no schema change, no migration.
- No `engine` enum (that is C4), no reproducibility contract (C5), no pipeline panel (C2),
  no worker diagnostics message / popover (C3).
- The readout never *blocks* anything: picking a clamped target is still allowed, it is
  merely explained.

---

## 4. Verification

- `npx tsc -p tsconfig.app.json --noEmit`, `npm run build`.
- `check-compile-identity --compare` — all library models byte-identical.
- `parity-agent-wasm.mjs`, `verify-agent-render.mjs` (the worker file is touched).
- In-browser: **Amphiphile** (async ⇒ grid WebGPU ✗ S), **Morphogenesis - Growing Tissue**
  (bonded WebGPU agents ⇒ ✓ + ⚠ F residency; Δt clamped 0.1 → 0.0625),
  **Cubic GRA** (agents WebGPU ✓ with notes — disproving "bonds prevent WebGPU"),
  **Game of Life** (all ✓), plus a closure annotation and an amber-chip case.

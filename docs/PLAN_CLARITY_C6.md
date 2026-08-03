# PLAN — Clarity C6: schema hygiene + update-mode vocabulary + loud fallbacks

Phase C6 of [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md) §C6,
implementing [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md)
**P5** (retire the legacy knobs) + the **P4** completion (loud fallbacks, UI side).
Illustrated mockup: [PLAN_CLARITY_C6.html](PLAN_CLARITY_C6.html).

**Mockup judgment (runbook §1.4 asks for it either way).** Two of the three
deliverables are copy-only (radio subtitles, one reject sentence) and would be exempt
as trivial. The third is **not**: an engine fallback stops painting the red persistent
"compile error" banner and becomes an amber one-time toast + an amber ⚙ chip. That is
an observable behaviour change on a shared surface, so a small before/after mockup is
warranted — and it is cheap. The mockup covers only that swap plus the two subtitles.

---

## 1. The gap

- **P5 / schema hygiene.** Engine physics has TWO mechanisms: the modern
  `agentCapabilities` profile and the legacy `customForcesOnly` / `useBondingPhysics`
  pair. The profile is supposed to win — but nothing states, or *checks*, that a model
  reaching the engine actually carries one. When it doesn't, the resolvers silently take
  their `?? legacy` arms and the user has no way to know their physics came from a field
  no panel shows.
- **Vocabulary.** Principle 1 of the doctrine says *sequential vs parallel*, and the
  Compatibility readout already speaks it — but the Update Mode radios, where the user
  actually makes the choice, say only "Synchronous / Asynchronous". The consequence
  ("…and therefore the GPU can't run it") is taught nowhere near the control.
- **P4, the UI half.** C3 built the worker-side fallback LOG. It is **pull-only**: the
  main thread learns about an event only while the diagnostics popover is open. A
  fallback's only push signal today is the **red persistent compile-error banner** —
  which mislabels a graceful degradation as a compile error, and disappears the moment
  anything else writes that banner.

## 2. What ships

### 2.1 Capability profile authoritative (P5)

| question | answer (verified, not assumed) |
|---|---|
| Does LOAD always seed the profile? | Yes for every agent model. `LOAD_MODEL` calls `migrateAgentCapabilities` unconditionally; the guard `if (topologyMode.agents && !centerBased) centerBased = defaultCenterBasedConfig()` runs earlier, so an agent model always has a `centerBased` for it to seed. Non-agent models have no `centerBased` and need none. |
| Does SAVE always write it? | Yes. `serializeModel` → `stringifyCompact` is a whole-object walker with no field picking; `withResolvedEngine` spreads `centerBased`. The profile rides along. |
| Does any save path still write `customForcesOnly`? | **No path in `src/` writes it at all** — it is read exactly once, in `usesBondingPhysics`. Only the generator scripts (which hand-author shipped fixtures) still emit it. Guarded by a new assertion. |

New pure predicate **`legacyPhysicsFlagsInEffect(cfg)`** in `centerBased.ts` — the EXACT
UNION of the two fallback conditions, derived from the same field tests:

```
!cfg                                  → false   (nothing to resolve)
!cfg.agentCapabilities                → true    (springs/growth/collision all fall back)
collision not one of the 3 literals   → true    (collisionMode falls back per-FIELD)
```

`usesBondingPhysics` (the adhesion μ_A knob) is deliberately **excluded**: it has no
capability control, so it is not a *fallback* — it is the only mechanism. It is named in
the removal schedule instead.

The worker calls it once per worker (`checkLegacyPhysicsFlags`, latched) after
`centerBasedConfig` is assigned in `init` and `recompile`, and emits the C3 event
*"legacy physics flags in effect — … Re-save the model to bake the profile."*
**No resolver logic or signature changes.**

### 2.2 Update-mode vocabulary (P5)

| radio | Synchronous | Asynchronous |
|---|---|---|
| **grid** `updateMode` | *(parallel — runs on all engines)* | *(sequential — CPU engines only)* |
| **agents** `agentUpdateMode` | *(parallel — runs on all engines)* | *(sequential — a cross-agent write needs a CPU engine)* |

**Deviation, deliberate.** The runbook proposes the identical pair on both radios.
Verbatim on the agent radio it would be **factually wrong**: an async AGENT model does
run on WebGPU — *Morphogenesis – Growing Tissue* ships exactly that way. What the
parallel GPU cannot honour is a cross-agent OVERWRITE, whose landing order only the
sequential CPU engines define (`isAgentGraphWebGPUSupported` rejects precisely that).
The subtitle keeps Principle 1's words and states the true consequence.

Reject texts realigned: `detectWebGPUModelIncompatibilities` (the sentence the
Compatibility readout shows for an async model) and the WebGPU grid engine hint. The
per-node texts inside `detectWebGPUIncompatibilities` are **left alone on purpose** —
they are captured by `check-compile-identity` as `webgpu.error`, the byte-identity gate
outranks a cosmetic rewording, and they already carry the doctrine ("WebGPU runs cells
in parallel…").

### 2.3 Loud fallbacks, UI side (P4)

`postFallback` gains `fallback: true` (+ `gen`) on the message it already posts. On the
main thread the `error` branch splits:

- **`fallback`** → a ONE-TIME amber toast (`showAgentNotice`, de-duplicated per distinct
  message per model via a `Set` ref) + `runtimeFallbackCount` (which keeps the ⚙ chip
  amber for the session) — and **not** the red banner.
- otherwise → unchanged.

`pendingStep.current = false` still runs in both branches (the step-pipeline unblock is
untouched). The count and the de-dupe set reset on `modelVersion`, like `diagnostics`.

The push is what lets the chip go amber **immediately**; the Events list stays the
durable record. The shared-GPU event sink is promoted from `logRuntimeEvent` to
`postFallback` — a lost device is the loudest fallback there is and previously reached
only the console plus the pull-only log.

**Not toasted:** the `webgpuGridFailed` "shader not produced" arm stays log-only (C3's
deliberate choice — the compiler already reports that reason through the compile-error
path; a second toast would double-report), and compile-time gate clamps stay in the C1
readout only, per the runbook.

## 3. Verification

- `check-compile-identity --compare` byte-identical; `tsc` + `npm run build`;
  `parity-agent-wasm`, `parity-agent-force`, `check-agent-wasm-gate`,
  `verify-agent-render`, `test-engine-resolve`, `test-generation-pipeline`,
  `gen-capability-docs --check`.
- `scripts/test-agent-capabilities.mjs` §8 (new): per shipped agent model —
  LOAD leaves no legacy arm in effect · SAVE writes and preserves the profile · the
  saved file needs no legacy arm · load→save→load is a fixed point · **NEG** stripping
  the profile makes the legacy arms fire again, and re-migrating bakes it back · a
  PARTIAL profile still trips the predicate · no `src/` path writes `customForcesOnly`.
  Both negative controls proven by source mutation.
- In-browser: three distinct forced fallbacks → one toast each, no repeat on
  re-occurrence, an Events row, an amber ⚙ chip; a hand-stripped legacy file fires the
  "resave to bake" event and a shipped model does not; both radio subtitles render.

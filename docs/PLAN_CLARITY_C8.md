# PLAN — C8: presentational-geometry taint check + pipeline label (P9, detection only)

Phase C8 of [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md),
implementing [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md) **P9**.
Illustrated companion: [PLAN_CLARITY_C8.html](PLAN_CLARITY_C8.html).

**Scope**: DETECTION ONLY. Nothing in the engine, the compilers or the worker changes;
`check-compile-identity` must stay byte-identical on every surface. No cadence or
location decoupling this phase — that is what the detection unlocks LATER.

---

## 1. The question, and why it is worth answering

The scariest chunk of implicit engine behaviour in an agent model is the force /
motion / layout block: ~7 phases of soft-sphere repulsion, charge, springs,
integration, growth and positional projection that the user never wrote. For a
large class of models that block decides **only where things sit** — the emergent
behaviour is identical under any layout. For another class it is load-bearing.
Nothing told the user which class their model is in.

P9's answer collapses the whole block into one honest sentence when it applies:

> **presentation only — does not affect your rule**

## 2. THE FRAMING — a grant of freedoms, not a gate

A model whose rules read positions into decisions is **fully supported** and simply
stays in today's exact, seeded, lockstep regime. Reading a position is a
**PROMOTION**: it moves the layout physics from "how the simulation looks" into
"part of what the simulation computes", and the exactness obligations follow from
that promotion.

So the UI must never style the tainted case as a warning. The presentational case is
green and informative; the promoted case is plain grey, states the promotion, and
shows its witness so the user can see exactly which wire made it so.

## 3. The criterion — dataflow taint

Geometry is presentational iff no dataflow path leads from a **geometry read** into
**non-geometric state**. The full source / sink / exemption tables live in the module
header of [`src/modeler/vpl/compiler/geometryTaint.ts`](../src/modeler/vpl/compiler/geometryTaint.ts)
(the single source; this plan does not duplicate them). The three load-bearing rules:

1. **The closed loop stays clean** (the *Cubic-GRA-midpoint rule*). Geometry into a
   position/force/velocity/radius write keeps geometry in a closed loop —
   `Get Self Position → expression → Create Agent.x` does not taint.
2. **The conservative default is TAINT.** The module allowlists the geometry-only
   sinks; **any other flow node taints**. A new state-writing node therefore taints
   from the day it is added unless someone deliberately allowlists it.
3. **Engine-geometric config taints with no wire to follow**: auto-bond ON (the
   engine builds topology from distance) and a reachable Divide Agent whose resolved
   partition is `tension` (geometry decides which bonds each daughter keeps).

## 4. Deliverables

| # | What | Where |
|---|---|---|
| 1 | `analyzeGeometryTaint(model) → { applicable, presentational, witness?, witnesses[] }`, pure | `src/modeler/vpl/compiler/geometryTaint.ts` (new) |
| 2 | `PipelinePhase.presentation` written on the mover phases (`PRESENTATION_PHASE_IDS`) | `src/model/generationPipeline.ts` |
| 3 | A `presentation` chip + the label on those rows; a legend entry | `PropertiesPanelContent.tsx` → `PhaseRow` / `GenerationPipelineBlock` |
| 4 | The informational note in the C1 Compatibility readout, with the witness | `PropertiesPanelContent.tsx` → `GeometryTaintNote` |
| 5 | Harness pinning a recorded HAND-AUDIT of every shipped agent model + the criterion + source-mutation controls | `scripts/test-geometry-taint.mjs` (new) |
| 6 | Docs sweep | `CLAUDE.md`, `HelpView.tsx`, `README.md` |

## 5. UI delta (why a full interaction mockup is not warranted)

The change is **two text additions inside two blocks that already shipped with their
own illustrated mockups** (C1's Compatibility block, C2's Generation Pipeline block):
a per-row chip + italic label, and one note paragraph. There is no new panel, no new
control, no new interaction and no layout change. The accompanying
[`PLAN_CLARITY_C8.html`](PLAN_CLARITY_C8.html) therefore shows the before/after of the
two affected rows and the dataflow criterion, rather than a full panel walkthrough.

```
  ▌ 12  Integrate & commit positions      [presentation] [per generation]
        v = 0.9·v + (0.05/1)·ΣF · speed cap 2
        presentation only — does not affect your rule
```

## 6. Verification plan

- `npx tsc -p tsconfig.app.json --noEmit`, `npm run build`.
- `check-compile-identity --capture` before / `--compare` after — **byte-identical on
  every surface** (the phase adds ZERO emit impact).
- `scripts/test-geometry-taint.mjs` — verdicts match the recorded hand-audit; witness
  KINDS asserted too, so "tainted for a different reason" fails; in-harness negative
  controls; `--mutate` patches the analyzer source and asserts the suite notices.
- `scripts/test-generation-pipeline.mjs` — its C2-era assertion *"C2 never sets
  `presentation`"* becomes *"only the mover phases may carry `presentation`"*.
- The standing gates: parity-agent-wasm, check-agent-wasm-gate, verify-agent-render,
  test-engine-resolve, test-agent-capabilities, test-archetypes,
  check-no-unseeded-random, gen-capability-docs --check.
- In-browser: the label is present on a presentational model and absent on a tainted
  one, and the C1 note renders in both states.

## 7. Explicitly out of scope

Layout cadence decoupling, render-side layout, the P9 explicit-consent door for
position-reading models, and any change to what the engine runs. C8 only makes the
property visible.

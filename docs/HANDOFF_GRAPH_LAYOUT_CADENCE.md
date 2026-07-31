# MASTER HANDOFF — Graph Layout (charge force) + Rule Cadence

**Audience**: the ORCHESTRATOR session and each PHASE session (a fresh session
executing exactly one phase). Single source of truth for sequence, protocol, status.

**Mission**: make a grown bond graph **readable** and **fast**, and give the rule
graph control over **when** it rewrites — without putting solver internals in the
graph.

**Design authority**: [IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md](IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md)
+ [PLAN_GRAPH_LAYOUT_CADENCE.md](PLAN_GRAPH_LAYOUT_CADENCE.md) (+ `.html`).
**Predecessor milestone**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
(GRA — complete; read its Status Board for what the agent tier can already do).

---

## 0. Invariants — EVERY phase session obeys these

1. **Git**: branch **`GRA`**, linear history, descriptive commits.
   **NEVER push. NEVER bump the version. NEVER add Co-Authored-By or any
   Claude/Anthropic attribution.** With the **Bash** tool use a heredoc
   (`git commit -F - <<'EOF' … EOF`) — the PowerShell `@'…'@` here-string is taken
   LITERALLY by bash and corrupts the message.
2. **Scope discipline**: your phase only. **If an assumption in your handoff proves
   false, STOP**, write it in your phase doc's Completion Report, commit, and end.
   The orchestrator re-plans. A truthful "assumption X is false, here is the
   evidence" is a SUCCESSFUL outcome.
3. **All-target delivery**: JS + WASM + WebGPU together, or a clean **capability-gate**
   rejection with a user-visible reason. Never a silent JS clamp.
4. **First principles**: gates key on general model properties only — never on a
   specific model or rule shape.
5. **Byte-identity is the primary regression net.** Both features are default-OFF;
   a model that does not use them must emit **identical code on every surface**.
6. **Verification gates before any commit** (all that apply):
   - `npx tsc -p tsconfig.app.json --noEmit` · `npm run build`
   - `node scripts/parity-agent-wasm.mjs` (add a permanent synthetic for new nodes)
   - `node scripts/parity-agent-force.mjs` — **mandatory for L1**
   - `node scripts/check-agent-wasm-gate.mjs` · `audit-agent-layout.mjs` · `test-agent-abi.mjs`
   - `node scripts/verify-graph-rewrite.mjs` · `verify-agent-render.mjs` · `verify-render-uniform-layouts.mjs`
   - `node scripts/check-compile-identity.mjs --compare <baseline>`
   - `node scripts/probe-graph-layout.mjs` — the layout-quality probe (L1, L3)
   - **REAL in-browser verification is mandatory.**
7. **Docs in the same commit**: CLAUDE.md · `src/help/HelpView.tsx` ·
   `docs/NODES_REFERENCE.md` (node changes) · README if warranted · this Status Board
   · your Completion Report. **A phase without its Completion Report is NOT done.**

## 0b. Known traps — measured, do not rediscover

- **`interactionRange` is a MULTIPLIER of contact distance, not a distance**, and the
  force is **zero past contact** (`muAdh` — *attraction* — applies between contact and
  the cutoff). Widening it does **nothing** for layout and can pull tighter. Measured.
- **The hash `binEdge`** is `max(range*2*maxR, neighbourQueryRadius)`. **Any new pair
  force must join that max** or the 3×3(×3) stencil silently truncates it.
- **There are TWO force pipelines on the GPU**: the canonical one and the **B1
  bin-sorted mirror** variant. A term added to one and not the other diverges only for
  models that engage the mirror.
- **The JS force loop has SEPARATE verbatim 2D and 3D arms.** Both need the change.
- **`dispatchResidentBatch` encodes ALL N generations into ONE submit** with no CPU
  touch point per generation — a uniform-supplied generation is constant across the
  batch. Measured at `agentWebgpuRuntime.ts` ~:2793.
- **Append, never insert mid-list**, in `AGENT_*_FIELDS` / `FORCE_PASS_PARAMS` /
  uniform structs — a mid-list lane shifts every later baked offset (P5's finding).
- **A WGSL uniform struct filled by a hand-written writer must be registered in
  `verify-render-uniform-layouts.mjs`**; a scalar after a `vec3` needs `@align(16)`.
- `sim.worker.ts` contains mojibake comment bytes — anchor `Edit` on ASCII **code**.
- The Browser pane may report hidden ⇒ Play auto-pauses; drive the worker directly
  (`window.__simWorker.postMessage({type:'step', count:N})`). `getState.agents.*` is
  **Float64**; only the render snapshot is f32. The service worker runtime-caches
  `.gcaproj` — fetch with `?t=Date.now()` + `{cache:'reload'}`.

---

## 1. Phase sequence

```
L1 charge force   ← READY   (the fix: overlap 99.2% -> ~0)
  └→ L2 cadence   ← READY   (Get Generation + Periodic Step + the GPU counter)
       └→ L3 solver knob + sample retune + Expression refactor   ← READY
```

**Launch order: L1 → L2 → L3.** L1 and L2 are technically independent, but L3 needs
both and serialising keeps the force pass under one editor at a time.

---

## 2. Status board

| Phase | Handoff | State | Commit | Notes |
|---|---|---|---|---|
| L1 Charge force | [HANDOFF_GLC_L1_CHARGE.md](HANDOFF_GLC_L1_CHARGE.md) | **DONE** | `GRA` | overlap **99.2 % → 0.2 %**, nnb/bond **0.18 → 0.81**. No Barnes–Hut. Assumption 4 partially FALSE (ForceControl was NOT in the uniform harness — registered, additive, no redesign). **L3 must enlarge the sample worlds**: `Cubic GRA` is saturated (4.6 units/agent vs rest 5), so it stalls at 14.3 % overlap live |
| L2 Cadence | [HANDOFF_GLC_L2_CADENCE.md](HANDOFF_GLC_L2_CADENCE.md) | READY | — | the GPU residency counter is the delicate part |
| L3 Samples + knob | [HANDOFF_GLC_L3_SAMPLES.md](HANDOFF_GLC_L3_SAMPLES.md) | READY | — | the visible payoff + the Expression refactor |

**States**: READY · IN PROGRESS · DONE · REPLANNED (assumption failed).

---

## 3. Verification recipes

### 3.1 The layout-quality probe — the oracle for L1 and L3
`scripts/probe-graph-layout.mjs` grows K4 → N by triangle split through the **real
engine force loop** and reports:

| metric | healthy | jammed |
|---|---|---|
| `bond` = mean bond ÷ rest | ~1–1.5 | 1.0 |
| `nnb/bond` = nearest **non**-bonded ÷ bond | **≥ 0.6** | **0.06** |
| `overlap%` | **~0** | **99.2** |

**L1 DONE**: the probe now drives the REAL WASM force pass over a real
`createAgentStore` (it used to carry its own copy of the force loop), and it
**asserts** its own gate — including that the charge-off baseline is still jammed —
exiting non-zero on failure. Post-rewiring the shipped baseline reads
`0.18 / 99.2 %` rather than `0.06 / 99.2 %`: the old copy modelled a narrower
repulsion than the engine has (`interactionRange` as an absolute distance rather
than a multiplier of contact distance). **Trust the post-L1 numbers.** Charge at the
default 8×-rest cutoff reaches `0.81 / 0.2 %`. The probe also reports a **3D cost
table** — the stencil is a volume, so 3D costs ~6.6× 2D at the same cutoff and 3D
models should start at ~4× the bond rest length.

### 3.2 The bin-edge trap test (L1)
Place two agents at `0.9 × chargeMaxDist` apart with **no** bond and assert a non-zero
charge force. If the bin edge was not widened, the stencil misses them and the force
reads zero — with everything else looking correct.

### 3.3 The residency trap test (L2)
Run a **multi-generation resident batch** and assert the rule observed **N distinct
generation values**. A uniform-only implementation returns one repeated value.
**Negative-control it** by reverting to the uniform and watching the test fail.

### 3.4 Cross-target expectations
JS ↔ WASM: **bit-identical** (both f64, both sequential). WebGPU: **statistical**
(f32 + per-agent PCG) — but structural invariants I1–I5 hold exactly everywhere.

---

## 4. Phase-session boot prompt (template)

```
You are implementing exactly ONE phase of the Graph Layout + Rule Cadence milestone.

1. Read docs/HANDOFF_GRAPH_LAYOUT_CADENCE.md §0 (invariants), §0b (measured traps —
   these will bite you if you skip them), §1, §3 (verification recipes).
2. Read your phase doc: {{PHASE_DOC}}. That is your scope. Nothing else.
3. Read docs/IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md §1 (the measured diagnosis) for WHY.
4. Branch: GRA. Do not push. Do not bump the version. No Claude attribution.
5. If any assumption proves FALSE: STOP, write it in your Completion Report, commit,
   and end. Do not redesign.
6. Run every applicable gate in §0.6 and record the results.
7. Finish with the Completion Report in your phase doc AND the Status Board row.
```

---

## 5. Completion Report template

```markdown
## Completion Report — L{{n}}
**State**: DONE | REPLANNED
**Commit(s)**: {{sha — subject}}
**Files touched**: {{git diff --stat}}

### What shipped
### Decisions resolved (with reasoning)
### Assumptions that proved FALSE   ← the orchestrator re-plans from this
### Verification
| Gate | Result |
### Layout metrics (L1/L3): bond · nnb/bond · overlap%, before -> after
### Known gaps / follow-ups
```

---

## 6. Orchestrator decision rules

1. **Any "assumption proved FALSE"** ⇒ re-plan successors before launching them.
2. **`check-compile-identity` diffs on a feature-off model** ⇒ the change is not
   additive. Investigate; do not justify.
3. **A phase that used a silent JS clamp** ⇒ reject (§0.3).
4. **L1 that does not move the probe metrics** ⇒ not done, regardless of green gates.
5. **L2 without the residency test** ⇒ not done; that bug is invisible otherwise.

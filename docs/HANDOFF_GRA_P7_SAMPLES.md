# PHASE P7 — The flagship samples (Cubic GRA, SDCA) + the documentation sweep

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3, §5. Design authority:
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P7, §4 (oracles **O6**, **O8**), §5 ·
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §6.2 (why our
operation set is safe to define ourselves).

**State**: READY · **Depends on**: P1–P6 + P4b (all DONE) · **This is the final phase.**

---

## 1. Why this phase exists

Every capability is now in place and individually verified. **Nothing yet shows a
user what the milestone is FOR.** This phase ships the two models that make the
capability legible, and proves the milestone's headline oracle **O6** inside a real
library model rather than a synthetic.

---

## 2. Sample A — `Cubic GRA` (the flagship)

A 3-regular graph rewriting itself while **staying** 3-regular. The rule is a
**table** and a **Randomize button**; the Overseer sweeps rule space and reports which
rules grow, die or blow up. That is the whole thesis of the milestone in one model.

### 2.1 The operation set (ours, deliberately — Impact Map §6.2)

| op | effect | ΔN | ΔE |
|---|---|---|---|
| **triangle split** — `v(a,b,c)` → `v₁,v₂,v₃`, `v₁–a`, `v₂–b`, `v₃–c`, triangle `v₁v₂v₃` | each new node: 1 external + 2 triangle = deg 3 | +2 | +3 |
| **edge swap** — `(a–b, c–d)` → `(a–c, b–d)` | — | 0 | 0 |
| **idle** | — | 0 | 0 |

`E = 3N/2` is preserved exactly (`3N/2 + 3 = 3(N+2)/2`). ⚠️ This is **our** set, not a
claim about Suzudo's — see Impact Map §6.2. Say so in the model description; do not
claim faithfulness to a specific paper.

**Triangle contract** (the inverse, ΔN −2 / ΔE −3) is **optional**. Include it only
if it lands cleanly; a growth-only rule already exercises O6 fully. If you skip it,
say so.

### 2.2 Build notes handed down (do not rediscover these)

- **The split is 5 queue ops** — 2 Rewire Bond + 3 Form Bond Between. Create Agent and
  Add Agent To World are host calls consuming **no** queue slot. It keeps `v₁` at
  degree 3 throughout, so it runs at **`maxBonds: 3`** and needs **no raised queue
  depth** (P4b).
- **The K4 bootstrap cannot live in the Agent Init Event** — Form Bond is init-invalid
  (it writes the queue at `idx`). Seed from the **behaviour graph gated on
  `myBondDegree == 0`**; a newborn already has degree 3 by its first behaviour step,
  so it never re-seeds (P4b).
- **Seed deterministically**: `seedPattern: 'scatter'` uses `Math.random()`. A rule
  reading bond degree is geometry-coupled, so use **`compact`** or the sweep will not
  reproduce (P6).
- **Sweep on JS/WASM, not the WebGPU agent target.** `setRngSeed` re-seeds the shared
  xorshift32 stream, but the WebGPU agent PCG is seeded once at runtime creation and
  never re-seeded, so a WebGPU-agent experiment does not reproduce (P6). Ship the
  sample on `wasm` and say why in the description.
- **The rule table**: census (`Neighbour Census` over the state attribute) → N-D
  Lookup Table (**tag-valued**: Idle / Split / Swap) → Switch → the verbs. Seeded
  **Randomize** so the user can roll rules. Clone P6's `Graph Metrics - Growth Sweep`
  Overseer graph and swap in this rule.
- **Graph indicators**: `nodeCount`, `edgeCount`, `maxDegree`, `degreeHistogram`.
  A cubic graph reads `maxDegree == 3` with the whole histogram in bucket 3 — **no
  degree-regularity metric is needed** (P6).

### 2.3 Exit oracle — **O6, in the shipped model**

Over **≥ 200 generations** of the shipped `Cubic GRA`, at **every** generation:

```
min degree == max degree == 3        and        E == 3N/2
```

plus I1–I5. **This is the milestone's headline result.** Add it to
`scripts/verify-graph-rewrite.mjs` as a permanent tier that loads the shipped model,
and **negative-control it** (e.g. omit the `v₂–v₃` edge ⇒ O6 must break while I1–I4
stay green — P4b already proved this control works).

---

## 3. Sample B — `SDCA — Couplers and Decouplers`

Ilachinski & Halpern 1987 (**verified** in `INVESTIGATION_GRAPH_CA.md` §13): a value
rule *plus* a link rule, dual-coupled — values evolve on the topology, topology
evolves on the values. Add the Nowotny & Requardt **hysteresis** band (on above λ₂,
off below λ₁, λ₂ ≥ λ₁) as the standard anti-flicker device.

- **Couplers / decouplers** = Form Bond / Break Bond driven by the endpoint states and
  the current link value.
- The **link value** is a **bond attribute** (P2/P3) — this is the model that shows
  why bond attributes exist.
- **⚠️ Document the link-update semantics honestly.** Bond attributes are
  **single-buffered on all three targets** (P3's standing decision), so a link write
  is visible to a later reader in the same generation, while *agent* attributes under
  sync are not. Say this in the model description and in Help. Do **not** attempt to
  fix it here — it is an all-three-targets change of its own (P3, P4).

### 3.1 Exit oracle — **O8**

- With thresholds that never fire ⇒ topology **exactly invariant**.
- Drive the neighbour density **up across λ₂ and back down to between λ₂ and λ₁** —
  the edge must **turn on once and not flicker**. A symmetric single threshold would
  flicker; that is the test.

---

## 4. Optional third sample (only if time allows)

A **typed-tissue** model exercising P5's `byBondAttribute` division ("apical bonds to
daughter A"). **No shipped sample uses a non-default partition** (P5), so this would
be its first real coverage. Skip it rather than rush it; say which you did.

---

## 5. The documentation sweep

The milestone's docs must read as one coherent feature, not eight phase reports.

- **`CLAUDE.md`** — a single coherent **Graph-Rewriting Automata** section covering
  the census, bond attributes, the request queue + Rewire + Form Bond Between, the
  division partition, graph indicators, and the samples. Fold in the per-phase text
  that accumulated; remove duplication. Update the Project Structure tree.
- **`src/help/HelpView.tsx`** — a user-facing "Graph-Rewriting Automata" section: what
  it is, the census → table → verb idiom, and how to read the samples.
- **`README.md`** — the feature and the two samples.
- **`docs/NODES_REFERENCE.md`** — final node counts + rows + Mermaid.
- **Library compile-target policy** — apply it to the new samples, **with the two
  documented exceptions stated in each model's description** (`Cubic GRA` on `wasm`
  for sweep reproducibility; anything else you deviate on).
- **The master handoff §2 Status Board** — mark P7 DONE and the milestone complete.

---

## 6. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **O6 in the shipped model** | ≥200 generations, `min deg == max deg == 3` and `E == 3N/2` at EVERY generation, negative-controlled |
| **O8** | hysteresis: no flicker in the band; invariant topology when thresholds never fire |
| **I1–I5** | hold every generation of both samples, ≥500 generations |
| **Both samples run on their gated-in targets** | 0 worker/console errors |
| **A VISIBLE-pane look** | the force-directed embedding is the entire point — **someone must actually look at both models rendering**. Take a screenshot of each. If the pane cannot be displayed, say so explicitly rather than claiming a visual check you did not make. |
| Byte identity | `check-compile-identity --compare .gra-baseline/compile-identity-P4b.json` — the 27 existing models unchanged; the new ones report as NEW |
| Standard gates | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` · `parity-agent-force` |

---

## 7. Assumptions to check FIRST (stop and report if any is false)

1. **The 5-op triangle split works from a library model's graph**, not just P4b's
   synthetic — same verbs, same order. Build it small and check O6 before adding the
   rule table on top.
2. **A tag-valued N-D Lookup Table can drive a Switch to three verbs** in an agent
   behaviour graph (the P1 macro shape). If the macro needs adjusting for the verb
   set, that is in scope; a structural blocker is not.
3. **`ovRandomizeTable` re-rolls the rule the sweep reads**, and the sweep reproduces
   on `wasm`. P6 verified this on its own sample — confirm on yours before building
   the whole protocol.

---

## Completion Report — P7

*(fill in per the master handoff §5 template. Additionally: a short **milestone
retrospective** — what the eight phases delivered end to end, which of the four gaps
from Impact Map §1 are now closed, and the honest list of what remains deferred.)*

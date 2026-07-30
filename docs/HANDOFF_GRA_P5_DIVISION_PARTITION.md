# PHASE P5 — Combinatorial division (per-bond daughter assignment)

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3, §5. Design authority:
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §3.4 (gap G2),
§5 (invariant I7), §6.1 (D4) · [PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md)
§P5, §4 (oracles I7, O4, O9).
**Predecessors' reports — read them**: P4 (the queue's shape; its §"For P5" is
addressed to you), P3 and P2 (bond attributes).

**State**: READY · **Depends on**: P2/P3 (bond attributes — the *naming* mechanism)
· **Blocks**: nothing

---

## 1. Goal, and an important scope correction

`divideAgent` partitions a mother's bonds to the daughters **geometrically**, by
`sign(dot(offset, m̂))`. GRA's division is *defined* by which edges go to which
daughter, so geometry is exactly the thing a user cannot say. This phase closes
gap **G2** by letting the user *name* the partition.

**Scope correction the orchestrator makes explicitly.** When this phase was planned,
the flagship cubic oracle **O6** was expected to need it. **It no longer does.** P4
delivered per-agent request queues plus atomic Rewire, and Create Agent already works
in the behaviour graph — so a cubic **triangle split** (`v(a,b,c) → v₁,v₂,v₃`) is now
expressible as *2 Create Agent + 3 Form Bond + 2 Rewire Bond* = 5 queued ops from one
agent, within the default depth of 8, with **no division at all**.

**Therefore: do not contort this phase to serve the cubic case.** Its real value is
biological and typed-graph division — "give daughter A the *apical* bonds" — which is
precisely what bond attributes made expressible. Keep it declarative and small.

---

## 2. Scope — what you build

### 2.1 `DivideAgent.partition` config

| mode | meaning |
|---|---|
| **`tension`** | today's geometric split. **DEFAULT, and must stay byte-identical.** |
| **`alternate`** | bonds alternate A, B, A, B… in slot order. Deterministic, needs no attribute. |
| **`byBondAttribute`** | a named bond attribute selects the daughter. |

For **`byBondAttribute`**, keep the mapping simple and legible:
- **bool** — `false` → daughter A, `true` → daughter B.
- **tag** — a per-option A/B assignment in the node's config UI (the natural shape,
  and it reads like the rule it encodes).
- **integer / float** — compare against a configured threshold; `<` → A, `≥` → B.

An unresolvable attribute (deleted, wrong type) must fall back to `tension` **and**
raise a `detectMissingConfig` badge — never silently mis-partition.

### 2.2 Decision D4 — the daughter–daughter bond

Today it is added **only when the mother was bonded**, so an isolated node divides
into two *unbonded* nodes. For graph rewriting you nearly always want it
unconditionally. Add a config, defaulting to **on** when the Graph-Rewriting
capability shape is active and to today's conditional behaviour otherwise — so no
shipped model changes.

### 2.3 The key design question — resolve it early and state it

`divideAgent` runs inside the engine's structural phase; the partition mode lives on
a **node's config**, and a model may hold more than one Divide Agent node. So the
mode must reach the engine somehow.

**Recommendation: ride the divide REQUEST**, exactly as `divideAxisX/Y/Z` and
`divideAsym` already do — a small `divideMode` lane (and, if needed, a bond-attribute
index lane). That keeps per-node fidelity and reuses P4's queue-field discipline:
a new lane goes in `AGENT_REQUEST_QUEUE_FIELDS` + `AGENT_GPU_QUEUE_FIELDS` +
`clearAgentBondRequests`, **and nowhere else** (P4's instruction to you).

If you find a materially better shape, take it — but state the choice and why.

### 2.4 Explicitly DEFERRED — `byRule`

A graph-authored per-bond callback during division (For Each Bond inside the Division
Event emitting *assign to A / B / both / drop*) is **out of scope**. P4 established
two blockers: the division event's ABI carries no request lanes, and a request raised
there would land a generation late. Record it as a follow-up; do not attempt it.

---

## 3. What this phase must NOT do

- **Do not** change the structural-phase ordering.
- **Do not** convert bond attributes to double-buffered storage (P3's standing
  decision; an all-three-targets change).
- **Do not** extend the queue drain outside `drainAgentBondRequests` in the engine.
- **Do not** implement `byRule` (§2.4).

---

## 4. Exit gate — all must pass, all recorded

| # | Oracle | Criterion |
|---|---|---|
| **`tension` byte-identical** | regression | `check-compile-identity --compare .gra-baseline/compile-identity-P4.json` — all 26 models unchanged. Plus a **Growing Tissue** run: same growth curve and same bond count as before the change. This is the most important gate — the default path must not move. |
| **I7** | **conservation across division** | the daughters' inherited (partner, attribute-tuple) multiset == the mother's, minus explicitly dropped, plus the new A–B bond — checked over **≥ 1000 divisions**, in every mode |
| **O9** | bond-attribute inheritance | attributes travel with their bond through the partition and are not re-initialised, in every mode |
| **O4** | deterministic growth law | every node divides every step, no death, ample capacity ⇒ exactly `N_t = N₀·2^t` and `E_t = E₀ + N₀·(2^t − 1)`. A shortfall means silent capacity rejection — catch it. |
| **I1–I5** | the standing invariants | hold every generation of every run above |
| — | `byBondAttribute` actually partitions | a model with `apical`/`basal` bonds divides so that each daughter receives exactly its named set — asserted by value, not by eyeball |
| — | Parity + targets | `parity-agent-wasm` with a **permanent division-partition synthetic**, JS↔WASM bit-identical with a value invariant; real-GPU run clean |
| — | Standard gates | tsc · build · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` (extend, negative-control each new invariant) · `verify-agent-render` · `parity-agent-force` |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **`divideAgent` is the only site that partitions bonds** — if another path also
   moves bonds between daughters, the mode must reach it too.
2. **The divide request already carries per-request payload** (`divideAxisX/Y/Z`,
   `divideAsym`) that survives P4's queue rework, so adding a lane is additive.
3. **Division still rejects the WHOLE operation on capacity overflow** (never a
   half-rewired partner). Your new modes must preserve that — verify before building.

---

## Completion Report — P5

*(fill in per the master handoff §5 template)*

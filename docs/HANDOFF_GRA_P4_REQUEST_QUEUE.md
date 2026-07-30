# PHASE P4 — Structural request queue + the Rewire verb

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes), §5 (Completion Report template).
Design authority: [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md)
§3.2, §3.3 (the defect), §5 (invariants I5/I6), §6.1 (D5, D6) ·
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P4, §4 (oracles O5, I5).

**State**: READY · **Depends on**: nothing structurally (P2/P3 are the bond-attribute
line; this is the request line) · **Blocks**: P5, and the milestone's flagship oracle O6

---

## 1. Why this phase is the keystone

Form Bond and Break Bond each write a **single `i32` cell** per agent:

```ts
// FormBondNode.compile
_bondFormReq[idx] = ((target)|0) + 1; _bondFormL[idx] = restLength; _bondFormK[idx] = stiffness;
// BreakBondNode.compile
_bondBreakReq[idx] = ((target)|0) + 1;
```

Both node descriptions already admit it: *"One request per agent per step — a later
call this step replaces an earlier one."*

Every degree-preserving graph rewrite — triangle split, pair annihilation, edge swap
— needs **2–5 edge mutations at one node in one step**. Emulating that across several
generations means the intermediate states **violate the very invariant the rule is
defined to preserve**, so invariant **I6** (`min deg == max deg == d`, `E == d·N/2`)
is not merely unmet, it is *untestable*. **This phase is what makes the milestone's
flagship oracle possible.**

---

## 2. Scope — what you build

### 2.1 Bounded per-agent request queues

Replace the single cells with **bounded queues**: capacity `D` slots per agent plus a
per-agent cursor. Decision **D5** recommends a fixed per-agent depth, default **8**,
user-configurable in Properties → Bond-Graph Agents.

- Addressing mirrors the bond store: `base = idx * D`, slot `c`.
- **Overflow REJECTS the excess op and surfaces a notice — never wraps, never
  half-applies** (invariant **I5**). Follow the existing `agentOverflow` notice
  precedent used by division and `formBond` capacity rejection.
- The structural phase drains each agent's queue **in slot order**, before death and
  division (do not change the existing phase ordering — bonds → death → division →
  division event → auto-bond → stale sweep).
- P2 added per-agent **bond-attribute initial-value** request cells alongside
  `bondFormL`/`bondFormK`. Those are part of a form request and must become
  per-slot too — miss them and initial values smear across queued bonds.

### 2.2 The `rewireBond` verb (decision D6 — ONE atomic op)

`rewireBond(from, to)`: atomically `break(self, from)` + `form(self, to)`. This is the
operation GRA actually names, and atomicity is free if the engine applies it as one
queue entry. **Do not** implement it as two queued ops — that reintroduces the
half-applied state I5 forbids, and it is what O5 tests for.

### 2.3 All three agent targets

Each target's emitter writes a queue slot and bumps the cursor:
- **JS** — `compile.ts` agent path.
- **WASM** — `agentWasm/compile.ts`; the request arrays are named layout regions
  (`ctx.layout.i32['bondFormReq']` etc.).
- **WebGPU** — the request fields live in `AGENT_GPU_REQUEST_FIELDS`
  (`'bondFormReq','bondFormL','bondFormK','bondBreakReq'`, plus the divide/kill set),
  laid out as runs in `agentF32`. A queue means `D` runs per field.
  **No atomics are needed** — each thread appends only to **its own** queue, and the
  emit is sequential within a thread. Do not reach for atomics; say in the report
  that you confirmed this.

### 2.4 Register the node properly

`rewireBond` needs the **five** edits or it half-works: the def, the registry, BOTH
`AGENT_*_SUPPORTED_TYPES`, `nodeValidation.detectMissingConfig`, and
`AGENT_NODE_REQUIREMENT` (requires `bonds !== 'off'`). The parity harness is what
catches a miss.

---

## 3. What this phase must NOT do

- **Do not change the division bond partition** — that is P5.
- **Do not** widen GPU residency, or touch the force pass.
- **Do not** convert bond attributes to double-buffered storage. P3 found they are
  single-buffered **by design on all three targets**; changing that is an
  all-three-targets semantic change and is explicitly NOT this phase (see §6).

---

## 4. Exit gate — all must pass, all recorded

| # | Oracle | Criterion |
|---|---|---|
| **I5** | **Atomicity** | a rule requesting `D + 3` ops per agent: **exactly `D` apply**, the remainder are rejected with a notice, and the resulting graph is *exactly* the pre-step graph plus those `D` ops. **No partial rewires anywhere.** |
| **O5** | **Pure rewiring conserves** | a rule using only `rewireBond`: **N, E and the full degree MULTISET are invariant** over 500 generations, exactly. (The multiset, not just min/max — a swap that moves degree between two nodes would pass a weaker check.) |
| **I1–I4** | handshake / symmetry / no-dangling / capacity | hold every generation of both runs above |
| — | **Multi-op in ONE step** | demonstrate a single agent performing ≥3 edge mutations in one generation and the graph being consistent immediately after — this is the capability the phase exists to deliver |
| — | Parity | `parity-agent-wasm` with a **new permanent queue synthetic** (queue several ops incl. a rewire, overflow the queue, break some bonds), JS↔WASM bit-identical, carrying a **value invariant** recomputed independently from the store |
| — | Byte identity | `check-compile-identity --compare .gra-baseline/compile-identity-P3.json` — all 26 models unchanged. **A model that issues at most one request per step must emit the same behaviour**; if the queue changes emitted code for such models, justify each diff. |
| — | Layout | `audit-agent-layout` + `test-agent-abi` before AND after |
| — | Real GPU + real worker | a queue/rewire model on all three targets, 0 errors; `createShaderModule` clean |

**Traps.** `verify-graph-rewrite.mjs` already has `checkHandshake`/`checkNoDangling`/
`checkCapacity` and Tiers through F — extend it, and **negative-control every new
invariant** (a harness that only ever passes proves nothing; P1 found three bugs
this way). The Browser pane may report hidden ⇒ drive the worker directly.
`getState.agents.*` is **Float64**.

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **The request cells are consumed in exactly one place** — the structural phase's
   step 1 — and cleared there. If any other site reads or clears them, the queue
   drain must cover it; report before building.
2. **Each agent writes only its own request slots** on every target (no cross-agent
   request writes). If a node can write *another* agent's request, the no-atomics
   claim in §2.3 is wrong and the WebGPU design changes.
3. **P2's bond-attribute form-request cells** are per-agent and part of the form
   request (so they become per-slot with it). Confirm their shape before changing it.

---

## 6. Known limitation to carry forward, NOT to fix here

P3 established that **bond attributes are single-buffered on all three targets**, even
under `agentUpdateMode: 'sync'` — so a bond-attribute write is immediately visible to
a later reader in the same generation, while *agent* attributes under sync are not.
True synchronous bond semantics would need `bondAttrsWrite` + a swap on the CPU store
**and** the matching GPU change — an all-three-targets milestone of its own. **Do not
schedule the GPU half alone** (P3's explicit warning). P7's SDCA sample must document
its link-update semantics honestly in light of this.

---

## Completion Report — P4

*(fill in per the master handoff §5 template)*

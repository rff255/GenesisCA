# PHASE P4b — the `Form Bond Between` verb (third-party bond formation)

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3, §5. **Predecessor**: [HANDOFF_GRA_P4_REQUEST_QUEUE.md](HANDOFF_GRA_P4_REQUEST_QUEUE.md)
— this phase completes its verb set and must obey its queue discipline.

**State**: READY · **Depends on**: P4 (the queue) · **Blocks**: **P7's flagship Cubic GRA
sample and the milestone's headline oracle O6**

**Origin**: inserted by the orchestrator while preparing P7. Not a defect — a genuine
expressiveness gap found by working the flagship sample's rule out on paper before
asking a session to build it.

---

## 1. The gap, precisely

The milestone's flagship oracle **O6** needs the cubic **triangle split**:

> `v` with neighbours `a,b,c` → `v₁,v₂,v₃`, with `v₁–a`, `v₂–b`, `v₃–c` and the
> triangle `v₁v₂, v₂v₃, v₃v₁`. Every new node has degree `1 + 2 = 3`; `a,b,c` keep
> degree 3. **ΔN = +2, ΔE = +3**, so `E = 3N/2` is preserved exactly.

With P4's queue, an agent `v` (becoming `v₁`) can already do almost all of it in ONE
step, well within the default depth of 8:

| op | verb | works today? |
|---|---|---|
| create `v₂`, `v₃` | Create Agent ×2 + Add Agent To World | ✅ |
| `v₁–v₂`, `v₁–v₃` | Form Bond ×2 | ✅ |
| re-point `b`→`v₂`, `c`→`v₃` | Rewire Bond ×2 | ✅ |
| **`v₂–v₃`** | — | ❌ **impossible** |

`formBond` is **self-to-target**. The `v₂–v₃` edge joins two agents that are *both*
newborns — neither is `self`, and neither runs its own behaviour until the next
generation. So the one edge that makes the split degree-preserving cannot be created,
and O6 is not expressible.

**This is not a workaround-able gap.** Spreading the split across two generations
leaves an intermediate state where `E ≠ 3N/2` and two nodes have degree 2 — i.e. it
violates precisely the invariant the rule exists to preserve, which is what O6 tests.

---

## 2. Scope — what you build

### 2.1 The verb

**`formBondBetween(agentA, agentB)`** — the requesting agent asks the engine to bond
two *other* agents. Same optional payload as Form Bond: rest length, stiffness, and
the per-bond-attribute initial values.

**The critical property that makes this cheap and safe: the request rides the
REQUESTING agent's OWN queue**, carrying two agent ids in its payload. No thread ever
writes another thread's queue, so — exactly as in P4 — **no atomics are needed on
WebGPU**. The CPU structural phase drains it and calls the existing
`formBond(store, a, b, L, K, attrs)`.

Semantics, mirroring the existing verbs:
- No-op if either id is out of range, dead, or `a === b`.
- No-op if already bonded.
- **Rejects (whole op, no partial state) if either endpoint's bond list is full** —
  invariant **I5**.
- Symmetric, like every bond: both rows get the slot, with identical attributes (**I2**).

### 2.2 The design question — resolve it early and state it

P4's queue entry encodes an op in **two lanes** (`0` = empty, `1` = side unused,
`v+2` = agent), and **a rewire already uses both lanes**. So `formBondBetween` — which
also needs two agent ids — **collides with the rewire encoding**. You must
disambiguate.

**Constraint that decides the shape** (learned by P5): a new lane appended
**mid-list** in `AGENT_F64_FIELDS` / `AGENT_GPU_F32_FIELDS` shifts every later baked
offset, which diffs every agent model's bytes and fails the byte-identity gate. P5
avoided a lane entirely for that reason.

So either:
- **append an op-kind lane at the very END** of the field list, so no existing offset
  moves (verify with `audit-agent-layout` + `check-compile-identity`), or
- **encode the op kind in the existing lanes' unused value space** (P4's `+2` bias
  leaves `0` and `1` as sentinels; a third sentinel or a sign convention may be
  enough).

Pick one, justify it, and **prove it with the byte-identity gate**.

### 2.3 All three targets, and the five registrations

Emit on JS, WASM and WebGPU. The node needs the **five** edits or it half-works: the
def, the registry, BOTH `AGENT_*_SUPPORTED_TYPES`, `nodeValidation.detectMissingConfig`,
and `AGENT_NODE_REQUIREMENT` (requires `bonds !== 'off'`).

**Extend `drainAgentBondRequests` in the engine, not the worker** (P4's standing
instruction). A new lane goes in `AGENT_REQUEST_QUEUE_FIELDS` + `AGENT_GPU_QUEUE_FIELDS`
+ `clearAgentBondRequests` and **nowhere else**.

---

## 3. What this phase must NOT do

- **Do not** build the Cubic GRA sample — that is P7. Build the *verb*, and prove it
  with a minimal synthetic.
- **Do not** change the structural-phase ordering, the division partition, or bond
  attribute buffering.
- **Do not** add any other new verb. One verb, one phase.

---

## 4. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **The triangle split works in ONE generation** | a synthetic agent performs *2 Create + 2 Form + 2 Rewire + 1 Form-Between* in a single generation, and immediately afterwards the graph satisfies **`min degree == max degree == 3` and `E == 3N/2`** — i.e. **O6 holds at every generation**, not merely at rule boundaries. **This is the gate the phase exists for.** Run it for ≥ 50 splits. |
| **I5 atomicity** | a Form-Between whose endpoint is full is rejected **whole** — the graph is exactly the pre-step graph. Verify by construction (fill a bond list, then request). |
| **I1–I4** | hold every generation of the above |
| **Symmetry (I2)** | the created bond is present in both rows with identical rest length, stiffness and every bond attribute |
| Parity | `parity-agent-wasm` with a **permanent form-between synthetic**, JS↔WASM bit-identical, carrying a **value invariant** recomputed independently from the store |
| Byte identity | `check-compile-identity --compare .gra-baseline/compile-identity-P6.json` — all 27 models unchanged; **any diff means the encoding shifted offsets** and must be fixed, not justified |
| Standard gates | tsc · build · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` (extend; negative-control the new invariant) · `verify-agent-render` · `parity-agent-force` |
| Real GPU + worker | the triangle-split synthetic on **all three targets**, 0 errors, `createShaderModule` clean |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **A newborn created this generation can be bonded in the same generation.** The
   structural phase creates agents and drains requests in the same pass; confirm the
   ORDER makes `v₂`/`v₃` valid bond targets by the time the Form-Between drains. **If
   it does not, say so immediately** — it changes the whole design and P7's sample.
2. **`formBond` can be called with two arbitrary ids** (it is `formBond(store, a, b, …)`
   — not implicitly self-relative) so the drain can call it directly.
3. **The queue's per-agent depth covers 7 ops** (default 8). If the triangle split
   needs more than the default, the sample will need a raised depth — note it for P7.

---

## Completion Report — P4b

*(fill in per the master handoff §5 template)*

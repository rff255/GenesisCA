# PHASE P3 — Bond attributes on the WebGPU agent target

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes), §5 (Completion Report template).
Design authority: [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md)
§3.6, §5, §6.1 (D3) · [PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P3.
**Predecessors' reports — read both**: [HANDOFF_GRA_P2_BOND_ATTRIBUTES.md](HANDOFF_GRA_P2_BOND_ATTRIBUTES.md)
(what exists on the CPU) and [HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md](HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md)
(**the read/write-base pattern you inherit**).

**State**: READY · **Depends on**: P2 (the CPU feature) + PX (the pattern) · **Blocks**: nothing

---

## 1. Goal

P2 shipped bond attributes on JS + WASM and made `isAgentGraphWebGPUSupported`
reject them at the **model level**. Lift that rejection by implementing bond
attributes on the GPU — subject to the one genuine hazard in §3.

---

## 2. What you inherit (do not re-derive)

**From PX — the settled pattern.** A second run set + a per-generation **commit
compute pass** (a same-buffer `copyBufferToBuffer` is a WebGPU validation error; the
L1 `posCommit` precedent). Aliased when async ⇒ an async model's shader stays
byte-identical. PX left you an `attrCommit` pass already wired into both the per-gen
path and (dead today, deliberately) the resident loop.

**From P2 — where the gate lives.** Two terms must be lifted **together**:
1. `isAgentGraphWebGPUSupported` rejects at the top on
   `bondAttrsOf(model).length > 0` (`agentWebgpu/compile.ts:3269`).
2. A matching hint arm in `PropertiesPanelContent` keyed on `model.bondAttributes?.length`.

**From P2 — why the gate is model-level, not node-level.** Form Bond grows one
initial-value input per bond attribute. A model could carry bond attributes and never
place a Get/Set node, yet still lose its Form Bond initial values on the GPU. So the
rejection cannot be per-node.

**The current GPU bond store.** Binding 11, `var<storage, read>` (**read-only**),
interleaved stride 2: `bondStore[idx*maxBonds*2 + k*2]` = partner (i32),
`+1` = rest length (f32 bits). `bondStoreLen = maxAgents * maxBonds * 2`.
`usesBondStore` gates the binding's **declaration** — Naga strips an unused storage
global and the bind group then mismatches the pipeline layout (a shipped bug).

---

## 3. THE DECISION you must resolve — `setBondAttribute` is a cross-agent write

**Do not discover this late; it is the crux of the phase.**

A bond is one object stored **twice** — in agent `i`'s row and in agent `p`'s row
(invariant **I2**, non-negotiable). So `setBondAttribute` necessarily writes a word
in **another thread's row**. That is structurally the same hazard the codebase
already gates:

```ts
// agentWebgpu/compile.ts:3361
const CROSS_AGENT_OVERWRITE = new Set(['setAgentAttribute','setAgentsAttribute','setAgentPosition','setAgentRadius']);
```

which the WebGPU gate rejects when reached from the behaviour graph with a wired,
non-spawn-handle id — because a sequential-order-dependent write cannot be honoured
by a parallel dispatch.

**The nuance that may rescue it.** If BOTH endpoints of a bond write it in the same
step, the two threads write the same words. Whether that is a bug depends on the
rule:
- **Symmetric rule** (the canonical SDCA link rule `λ' = ψ(λ, σᵢ, σⱼ)` **is**
  symmetric in `i,j`): both endpoints compute the *identical* value ⇒ the race is
  **benign**, the result is deterministic.
- **Asymmetric rule**: the endpoints compute different values ⇒ genuinely
  order-dependent, and CPU (sequential, index order) and GPU will disagree.
- **One-sided rule** (P2's D2 `ownerId` idiom — write only the bonds you own): only
  one thread writes ⇒ no race at all.

Symmetry is a **model** property, not a general one, so a gate cannot test it.

**Your job: measure, then choose, then state the choice.** Build a both-endpoints-
write model with an **asymmetric** rule and run it on real hardware. Then take one:

- **(A) Allow, and document.** `setBondAttribute` is supported on WebGPU; concurrent
  writes to the same bond from both endpoints are **order-undefined on WebGPU** —
  write from one side, or make the rule symmetric. Document in the node description,
  HelpView and CLAUDE.md.
- **(B) Gate it.** Add `setBondAttribute` to `CROSS_AGENT_OVERWRITE`, so a model that
  *writes* bond attributes in its behaviour clamps to WASM/JS while **reads and Form
  Bond initial values still run on the GPU**. Strictly consistent with the existing
  precedent.

**Recommendation: (A), if and only if your measurement shows the one-sided and
symmetric cases are exact and only the asymmetric case diverges** — because (B)
clamps SDCA (whose link rule writes every step) off the GPU entirely, and the
asymmetric case is already undefined-by-nature rather than newly broken. If the
measurement shows something worse — for example a torn or lost write even in the
one-sided case — take (B) and say so. **Either choice is acceptable if it is
measured and stated. An unmeasured choice is not.**

---

## 4. Scope — what you build

1. **Layout** — widen `bondStore` from stride 2 to `2 + N` through **one shared
   constant** (`BOND_STRIDE` or similar). **Never** a find-and-replace over the
   `* 2u` sites; there are several and a missed one reads the wrong lane silently.
   Add `bondAttrBase` / `bondAttrWriteBase` per the PX pattern, aliased when async.
2. **Binding** — promote binding 11 to `var<storage, read_write>` when bond
   attributes are present (decision **D3**), keeping `usesBondStore` gating the
   declaration.
3. **Emit** — `getBondAttribute` (scan the row for the partner, epoch-valid; **no
   bond ⇒ the attribute's default**, never garbage) and, per §3, `setBondAttribute`
   (both slots). Reads via the read base, writes via the write base.
4. **Form Bond initial values → the GPU request fields.** This is the reason the gate
   is model-level; it is easy to forget because no Get/Set node need be present.
5. **Commit** — fold the bond runs into PX's existing `attrCommit` pass if the
   regions are contiguous (widen the baked literals); otherwise a second pass. Say
   which.
6. **Runtime** — upload/readback the attribute lanes in `agentWebgpuRuntime.ts`.
7. **Lift the gate** — both terms from §2, together.

**Out of scope**: the request queue (P4), division partition (P5), residency
widening, `forEachBond` exposing attributes (P2 deferred it deliberately — its four
outputs are id-cached in three emitters).

---

## 5. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **I2 on the GPU** | bond symmetry holds every generation of a 200-generation run — extend `verify-graph-rewrite`'s Tier for the GPU path, negative-controlled |
| **Cross-target agreement** | the same bond-attribute model on JS, WASM and WebGPU: **structural invariants I1–I4 hold exactly on all three**; values agree exactly for a one-sided rule (bond attributes are integer/tag/bool exactly, and float within f32) |
| **The §3 measurement** | recorded with numbers, and the decision (A) or (B) stated with its reasoning |
| **Async byte-identical** | `check-compile-identity --compare .gra-baseline/compile-identity-PX.json` — a model without bond attributes must be unchanged on every surface. Justify every diff. |
| Real GPU | `createShaderModule` 0 errors + 0 validation errors, 2D **and** 3D; a real in-browser run with 0 worker/GPU errors |
| Standard gates | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` · `verify-render-uniform-layouts` |

**Verification traps** (both cost a predecessor a confusing run):
- The service worker runtime-caches model `.gcaproj` (StaleWhileRevalidate), so a
  browser probe fetching a file you just edited gets the **pre-edit** copy. Use
  `fetch(url + '?t=' + Date.now(), { cache: 'reload' })`.
- The Browser pane may report hidden ⇒ Play auto-pauses. Drive the worker directly
  (`window.__simWorker.postMessage({type:'step', count:N})`). `getState.agents.*`
  ships **Float64**; only the render snapshot is f32.

---

## 6. Assumptions to check FIRST (stop and report if any is false)

1. **PX's `attrCommit` pass exists and is wired into the per-gen path**, and its
   read/write-base accessor is the single point through which attribute access flows.
   If PX took a different design than its report states, re-read before building on it.
2. **The bond store's stride-2 literal is confined to a small, findable set of sites.**
   If it is scattered beyond a handful, say so before widening — a missed site is a
   silent wrong-lane read.
3. **`usesBondStore` genuinely gates the binding declaration** (the Naga strip trap).

---

## Completion Report — P3

*(fill in per the master handoff §5 template)*

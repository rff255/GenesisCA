# PHASE PX — WebGPU agent attributes honour `agentUpdateMode: 'sync'`

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes), §5 (Completion Report template).

**State**: READY · **Depends on**: nothing (P2 touched no GPU attr path — confirmed in
P2's report) · **Blocks**: P3 (which must decide whether GPU *bond* attributes need
the same treatment, and should inherit a settled pattern)

**Origin**: inserted by the orchestrator from **P1's finding (b)**. Pre-existing
defect, not caused by any phase of this milestone.

---

## 1. The defect

On the WebGPU agent target the behaviour shader reads a neighbour's attribute and
writes its own from **the same memory**. [agentWebgpu/layout.ts](../src/modeler/vpl/compiler/agentWebgpu/layout.ts)
allocates exactly **one** run per user agent attribute:

```ts
const agentAttrBase: Record<string, number> = {};
for (const id of agentAttrIds) { f32Base[id] = off; agentAttrBase[id] = off; off += ma; }
```

and all ~8 emit sites in [agentWebgpu/compile.ts](../src/modeler/vpl/compiler/agentWebgpu/compile.ts)
resolve both reads and writes through that single `agentAttrBase[attr]`. Threads run
in parallel and in an unspecified order, so within one dispatch **agent A's write is
visible to agent B's read**. That is async (single-buffer) semantics, silently
applied to a model the user configured as **synchronous**.

The CPU targets do this correctly: `agentUpdateMode: 'sync'` allocates a distinct
`attrWrite`, and the worker calls `primeAgentAttrWrite` before the behaviour and
`swapAgentAttrs` after ([agentEngine.ts](../src/simulator/engine/agentEngine.ts),
[sim.worker.ts](../src/simulator/engine/sim.worker.ts)).

**Measured by P1** (evidence, not inference): against a Conway reference from an
identical board, the shipped, census-free **`Game of Life on Agents` is wrong by 18
of 1024 cells on its own WebGPU target** and exact on JS/WASM; P1's `Life on Bonds`
was wrong by 14 *or* 18 varying run to run — the variation **is** the race.

## 2. Why it is in scope for this milestone

1. **GRA rules are canonically synchronous.** The flagship samples (P7's Cubic GRA,
   SDCA) would be silently wrong on WebGPU.
2. It blocks `Life on Bonds` from the library's WebGPU-where-gated-in policy — P1
   deliberately shipped it on `wasm` because it is a differential oracle and
   correctness outranks the perf policy.
3. **P3 must decide the same question for GPU bond attributes.** It should inherit a
   settled pattern rather than invent one PX then changes.

---

## 3. Scope — what you build

### 3.1 The recommended design: a second run set + a commit pass

**There is an exact precedent in this codebase — follow it.** The L1 voxel work
needed to commit `xNext → x` GPU-side and could not use `copyBufferToBuffer`, because
**a same-buffer copy is a WebGPU validation error**; it used a small **compute pass**
(`posCommit`) that also zeroed the force accumulators. Do the same here.

1. **Layout** — when the model is sync AND has ≥1 user agent attribute, allocate a
   **second run per attribute**: `agentAttrWriteBase[id]`. When async, set
   `agentAttrWriteBase[id] === agentAttrBase[id]` (aliased, zero extra bytes).
2. **Emit** — every **read** resolves through `agentAttrBase`, every **write** through
   `agentAttrWriteBase`. With the aliasing above, an **async model's shader is
   byte-identical to today** — that is the byte-identity gate, and it is how you know
   you have not disturbed the 8 shipped agent models.
3. **Commit** — a small compute pass copying the write runs onto the read runs, run
   **once per generation, after the behaviour dispatch**, only when sync. Mirror
   `posCommit`: one dispatch over `maxAgents` via the 2-D `dispatchCells` tiling
   helper (a flat 1-D dispatch silently no-ops past 4.19M invocations).
4. **Readback** — `readbackAgentStep` currently commits GPU attrs into `s.attrWrite`
   and the worker then calls `swapAgentAttrs`. Re-check that path against the new
   layout so the CPU mirror ends up holding the **committed** values exactly once.
   Getting this wrong is a silent off-by-one-generation, so assert it with a value
   test, not by reading the code.

**If you find a materially simpler correct design** (for example ping-ponging the
bases through the Control uniform — note the bases are currently **baked as WGSL
literals**, so that would touch all 8 emit sites), you may take it — but state the
choice and the reasoning in the Completion Report.

### 3.2 The fallback, only if 3.1 proves infeasible

Reject sync + a cross-agent attribute read on the WebGPU agent target at
`isAgentGraphWebGPUSupported`, with a user-visible reason in the Properties
agent-target hint. **This is strictly worse** — it clamps a whole class of models
(every synchronous GRA rule) off the GPU — so treat it as a last resort, and if you
take it, **stop and report rather than also doing P3's work around it**.

### 3.3 Explicitly out of scope

- **Residency.** `agentResidentEligible` requires async attrs today, so a sync model
  already takes the per-gen path. **Keep that restriction.** Widening residency to
  sync models is a separate milestone (the agent-render handoff's phase F).
- Bond attributes on the GPU — that is P3.
- Any change to the CPU sync path, which is correct.

---

## 4. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **The bug is fixed, measured the same way P1 measured it** | `Game of Life on Agents` on `agentTarget: 'webgpu'`, sync, must match a Conway reference from an identical board **exactly (0 of 1024 cells wrong)**, and must be **stable across repeated runs** (the run-to-run variation was the race — run it at least 3 times). |
| **Async is untouched** | `check-compile-identity` — all 26 models unchanged. An async agent model's WGSL must be **byte-identical**; say so explicitly, having diffed a shader. |
| **`Life on Bonds` flips to WebGPU** | Once green, switch it to `agentTarget: 'webgpu'` per the library policy and re-run P1's O7 differential (cell-for-cell vs. `Game of Life on Agents`) **on the GPU**. If it does not pass, the fix is incomplete — do not ship the flip. |
| Real GPU | `createShaderModule` 0 errors + 0 validation errors; a real in-browser run with 0 worker/GPU errors. |
| Standard gates | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` |
| Baseline | `node scripts/check-compile-identity.mjs --compare .gra-baseline/compile-identity-P2.json` |

**Verification note.** The Browser pane may report hidden, which auto-pauses Play —
drive the worker directly (`window.__simWorker.postMessage({type:'step', count:N})`)
and read state back via `getState`. Remember the f64 trap: `getState.agents.*` ships
**Float64** buffers; only the render snapshot is f32.

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **`agentAttrBase` is genuinely the only attribute run** and is used for both reads
   and writes (the orchestrator verified this at `layout.ts:260` and 8 sites in
   `compile.ts`). If a write path already routes elsewhere, the diagnosis is wrong —
   stop.
2. **Sync models are excluded from GPU residency today.** If they are not, the commit
   pass must also be wired into the resident batch loop, which changes the scope —
   report before proceeding.
3. **The 18/1024 error reproduces** before you change anything. Reproduce it FIRST.
   A fix for a bug you have not reproduced is not verifiable. If it does not
   reproduce, stop and report — the diagnosis may be incomplete.

---

## Completion Report — PX

*(fill in per the master handoff §5 template)*

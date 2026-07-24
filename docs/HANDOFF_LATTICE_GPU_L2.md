# PHASE HANDOFF — L2: Pipelined step batches (overlap CPU and GPU)

Read first: [HANDOFF_LATTICE_GPU.md](HANDOFF_LATTICE_GPU.md) §0 Invariants + §3
Protocol + your Status Board row. Then this document top to bottom. Then
[IMPACT_MAP_LATTICE_GPU.md](IMPACT_MAP_LATTICE_GPU.md) §2 (L2 row) + §3 (risk 2 —
this is the highest-risk phase in the plan) and
[PLAN_LATTICE_GPU.md](PLAN_LATTICE_GPU.md) §L2.
CLAUDE.md sections: "WebGPU Compile Target" and — **mandatory** — the
"Agent-engine performance review round" paragraph on the async step-batch
re-entrancy P0 bug.

---

## 0. THIS PHASE OPENS WITH A MEASURE-FIRST GATE

The whole phase rests on one number measured in an **occluded** browser pane:
a WebGPU grid costs a **flat ~7 ms per step batch regardless of grid size**,
of which ~6.7 ms is submit→fence latency around a 0.17–1.08 ms kernel
([PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md) §4).

**Step 0 is to re-measure it in a VISIBLE pane** (ask the orchestrator/user to
front the browser window, or run the dev server and drive it from a normal
window). Use the `count:0` / `count:1` / `count:N` decomposition:

| probe | 1000² measured (occluded) | what it isolates |
|---|---|---|
| `{count:0, skipColorPass:true}` | 0.53 ms | round trip + fence with nothing submitted |
| `{count:0}` | 4.05 ms | + OM dispatch + present + reductions |
| `{count:1, skipColorPass:true}` | 7.51 ms | + ONE dispatch and its fence |
| `{count:10}` / `{count:100}` | 1.02 / 0.362 ms per gen | the marginal kernel |

**Decision rule.**
- Visible-pane fixed cost still ≳ 4 ms → **proceed** with the phase.
- Visible-pane fixed cost ≲ 1.5 ms → **STOP**. Write the numbers into your
  Completion Report and into `PERF_REVIEW_LATTICE.md` §4 (replacing the caveat),
  mark L2 **cancelled — not worth doing** on the Status Board, and end the
  session. A documented negative is a successful outcome here.
- In between → report and let the orchestrator decide; do not guess.

Also record whether the latency is **grid-size independent** (it was: 6.2 / 7.2 /
6.7 ms at 300² / 1000² / 2000²). If it scales with grid size in a visible pane,
the diagnosis is wrong and you should stop.

## 1. Objective (if the gate passes)

Stop serializing CPU and GPU. Today: the worker fences
(`await rt.device.queue.onSubmittedWorkDone()` in `finalizeStepWebGPU` when there
is nothing to read back) before posting `stepped`, and the main thread only posts
the next batch **from** the `stepped` handler. The GPU is idle while the CPU
works and vice versa.

**Target**: 2D WebGPU at gens/frame = 1 goes from 7.2 → ~1.5 ms/frame. Compounds
with L1 in 3D.

## 2. Design

**Bounded pipelining.** Allow batch *N+1* to be **encoded and submitted** while
batch *N*'s fence is still outstanding, with a hard cap on in-flight batches
(start at 1, i.e. at most one un-fenced batch ahead) so back-pressure survives.
The fence still exists — it just stops being on the critical path of the frame
the user is waiting for.

**The invariant that must NOT change**: `asyncStepBatchInFlight` keeps deferring
**every** incoming message and replaying it when the batch settles. Concurrent
*batches* were the P0 corruption bug in the agent arc (stale CPU uploads racing
fresh GPU results, zero errors reported). Only the **GPU fence** relaxes; the
**message-ordering semantics are untouched**. If you find yourself removing or
weakening the deferral, you have left the design.

Practical shape (adapt to the real code):
- Keep exactly one logical "batch in flight" for message purposes.
- Split the tail: submit the batch's work, then post `stepped` **after** the
  work is *submitted* rather than *completed*, and hold the fence promise; the
  NEXT batch awaits the previous fence before it *submits*, so at most one batch
  is un-fenced.
- Any path that reads back (stop-flag checks, watched indicators, recording,
  inspect, `getState`) must still await its own readback — a readback is a fence.
  So models with per-gen stop checks or watched indicators naturally fall back
  to today's behaviour: **that is correct, not a gap**.

**Optional sub-item (bonus, only if time remains): K generations in ONE
encoder.** `dispatchStep` ([webgpuRuntime.ts](../src/simulator/engine/webgpuRuntime.ts):919)
is one encoder + one submit per generation. Recording K generations as K compute
passes in a single encoder is valid (WebGPU orders passes within a submission
and tracks hazards), and the A/B bind-group ping-pong just alternates per pass.

Blockers to gate on:
- the per-generation standalone-indicator reset uses `queue.writeBuffer`
  ([webgpuRuntime.ts](../src/simulator/engine/webgpuRuntime.ts):889
  `uploadIndicatorsAt`), which is **queue-ordered, not encoder-recordable** — it
  would apply before *all* passes. ⇒ gate the sub-item on
  `standalonePerGenIdx.length === 0`.
- `resetStopFlag` (:835) is also `queue.writeBuffer`, but `enc.clearBuffer` on
  the control buffer's stop-flag offset is an encoder-recordable equivalent.
- `clearGlyphBuffersWebGPU` (:1171) already uses `enc.clearBuffer` — folds in.
- Stop-event models: batch at most `webgpuStopCheckInterval` generations per
  encoder so the existing K-step semantics are preserved exactly.

The review measured this sub-item as **low value on its own** (the marginal
per-gen cost is small; the fence is the cost). Do not let it eat the phase.

## 3. Gate (GENERAL properties only)

Pipelining applies iff: the resolved grid target is WebGPU **and** the batch tail
does not itself require a readback this frame (no per-gen stop check, no watched
indicator readback, not recording, no inspect popover, `getState` not pending).
All of those are already computed in `finalizeStepWebGPU`; reuse them — do not
invent a parallel set of flags.

## 4. Do NOT touch

- **Any compiler file.** `check-compile-identity` must be all-unchanged.
- The `asyncStepBatchInFlight` / `deferredDuringAsyncBatch` message semantics.
- The agent step paths (`runAgentStepWebGPU`, `runAgentBatchResident`) — an agent
  model's batch already has its own residency logic; gate L2 to the non-agent
  WebGPU grid branch and say so.
- The JS/WASM synchronous batch loop.

## 5. Verification checklist

**Static**
- [ ] `npx tsc -p tsconfig.app.json --noEmit`, `npm run build`
- [ ] `node scripts/check-compile-identity.mjs` all-unchanged
- [ ] `node scripts/parity-agent-wasm.mjs` + `parity-agent-force.mjs` green
- [ ] `git diff --stat` = `sim.worker.ts` (+ optionally `webgpuRuntime.ts`) + docs

**In-browser (real GPU)**
- [ ] Step 0's visible-pane measurement is recorded in the report **before** any
      implementation
- [ ] Before/after `count:1` frame time at 300² / 1000² / 2000² (Game Of Life)
- [ ] **The overlapped-burst reproducer**: post ~10 `step` messages of ~40 gens
      each *without awaiting between them* and confirm the simulation is still
      correct (for Game Of Life: compare the final `getState` alive-count against
      the same number of strictly sequential single batches — they must match
      exactly, because GoL is deterministic and no RNG is involved). This is the
      test that caught the P0 agent bug; it is non-negotiable here.
- [ ] A **stop-event** model still pauses on the correct generation
      (Chromatography or a patched Game Of Life with a Stop Event) at
      `webgpuStopCheckInterval` 1 and >1
- [ ] A **watched linked indicator** model (Extended Wireworld on WebGPU) still
      reports the same per-frame values as before
- [ ] Recording still captures every frame
- [ ] `pushErrorScope('validation')` reports 0 errors; `device.lost` only ever
      fires with reason `destroyed`
- [ ] Fallbacks: JS/WASM grids and agent models unchanged

## 6. Docs to update

- `CLAUDE.md` — the WebGPU Compile Target section: the pipelining behaviour, its
  gate, and the preserved message-deferral invariant.
- `PERF_REVIEW_LATTICE.md` §4 — replace the occlusion caveat with the
  visible-pane number (whether or not the phase proceeds).
- This document's Completion Report + the master Status Board row.

## 7. Completion Report

`## Completion Report (<date>)`
- **the Step-0 visible-pane measurement** and the decision it drove
- commits; deviations and why
- before/after frame times; the burst-reproducer result
- whether the single-encoder sub-item was attempted and what it measured
- new gotchas (add durable ones to master §0.7)

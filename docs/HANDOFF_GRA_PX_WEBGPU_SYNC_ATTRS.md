# PHASE PX — WebGPU agent attributes honour `agentUpdateMode: 'sync'`

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes), §5 (Completion Report template).

**State**: **DONE** (see the Completion Report) · **Depends on**: nothing (P2 touched no
GPU attr path — confirmed in P2's report) · **Blocks**: P3 (which must decide whether GPU
*bond* attributes need the same treatment, and now inherits a settled pattern)

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

**State**: **DONE**

**Commit(s)**
- `feat(agents): honour sync agent update mode on the WebGPU target`

**Files touched**

```
 src/modeler/vpl/compiler/agentWebgpu/layout.ts   (agentAttrWriteBase + syncAttrs; the second run block)
 src/modeler/vpl/compiler/agentWebgpu/compile.ts  (attrAt read/write accessor; 4 read + 5 write sites; extras)
 src/simulator/engine/agentWebgpuRuntime.ts       (write-run prime, the commit WGSL + pipeline + dispatch)
 src/simulator/engine/sim.worker.ts               (the legacy layout-recompute fallback carries syncAttrs)
 scripts/verify-graph-rewrite.mjs                 (TIER E — 17 checks, 2 negative controls)
 scripts/gen-life-on-bonds.mjs                    (agentTarget wasm -> webgpu + the rationale)
 public/models/Life on Bonds.gcaproj              (the same two fields, edited surgically to keep node ids stable)
 CLAUDE.md · README.md · src/help/HelpView.tsx    (the corrected claims + the PX section)
```

**No engine, store, ABI-descriptor, CPU-sync-path, JS/WASM-agent or lattice file was touched.**

### What shipped

**The measured defect.** On the WebGPU agent target the behaviour shader read a neighbour's
attribute from the SAME `agentF32` run it wrote its own into. Threads run in parallel and in an
unspecified order, so **agent A's write became agent B's read inside one dispatch** — async
(single-buffer) semantics silently applied to a model the user configured as synchronous.

**Reproduced FIRST, before any code change** (real worker, real GPU, the shipped
`Game of Life on Agents` on its own `agentTarget: 'webgpu'`, `setRngSeed` + Reset → an identical
286-alive board, one step, against a hand-written Conway reference):

| target | wrong of 1024 | post-step alive |
|---|---|---|
| JS | **0** | 359 |
| WASM | **0** | 359 |
| **WebGPU** (4 trials, identical board) | **123 · 56 · 32 · 32** | 330 · 335 · 355 · 347 |

The JS/WASM zeros validate the measurement procedure; the run-to-run variation **is** the race.
(Magnitude differs from P1's 18/1024 — a different seed and a single step from a fresh reset —
but the defect and its signature are the same.)

**The fix — a second run + a per-generation commit pass** (the CPU targets' double buffer, ported):

1. **Layout** — `AgentWebGPUExtras.syncAttrs` (from `centerBased.agentUpdateMode`, via
   `agentWebGPUExtrasOf`) allocates a **second contiguous block of per-attribute runs**,
   `agentAttrWriteBase[id]`, immediately after the read block and in the same attribute order.
   **Async ⇒ the write base ALIASES the read base** (identical value, zero extra bytes).
2. **Emit** — one accessor `attrAt(ctx, attr, idx, 'read' | 'write')` replaces every
   `f32At(ctx, attr, …)`. Reads: `getCellAttribute`, `getAgentAttribute`, the `getAgentsAttribute`
   gather, `filterAgents`. Writes: `setAttribute`, `updateAttribute`, `setAgentAttribute`,
   `setAgentsAttribute`, `createAgent`'s newborn defaults. `updateAttribute` read-modify-writes the
   WRITE run, mirroring JS `w_<attr>[idx]` and WASM `pushAgentAttrWriteAddr`.
3. **Commit** — a compute pass appended to every `dispatchAgentStep` encoder folds write → read once
   per generation. A COMPUTE pass, not `copyBufferToBuffer` (a same-buffer copy is a WebGPU
   validation error — the L1 `posCommit` precedent). Both blocks are contiguous ⇒ **one linear copy**
   of `agentAttrIds.length · maxAgents` elements via the 2-D `dispatchAgents` tiling. Covers **all
   `maxAgents` slots**, so a Create Agent newborn beyond `highWater` is committed before the reconcile.
   Built only when `layout.syncAttrs`.
4. **Prime** — `uploadAgentSoA` seeds the write runs from `s.attrRead` too (the GPU analogue of
   `primeAgentAttrWrite`). Mandatory: an attribute the behaviour never writes would otherwise be 0 in
   the write run and the commit would clobber it.
5. **The readback side is UNCHANGED** — after the commit the READ runs hold the committed generation,
   so `readbackAgentStep`, the spawn reconcile and `readbackAgentFrame` keep reading `agentAttrBase`
   verbatim. Verified by value (0/1024 wrong end-to-end), not by reading the code.

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| The design | **§3.1 as recommended** — a second run set + a commit compute pass — NOT the §3.2 fallback and not a simpler variant | A simpler variant genuinely exists (the per-gen path re-uploads the whole SoA every generation, so *routing writes to the write run and reading THEM back* would also be correct without any commit pass). It was rejected: it would force **three** runtime readback sites (`readbackAgentStep`, the spawn reconcile, `readbackAgentFrame`) to switch to `agentAttrWriteBase`, and it would leave the GPU's own read runs holding a stale generation — so any future GPU-side consumer (the A1.5 OM colour pass, a residency widening) would silently read last generation. The commit pass makes the GPU state **self-consistent after every dispatch**, which costs one dispatch on a path that already does a full CPU upload + readback per generation, and keeps every readback site byte-unchanged. |
| Where the commit runs | Appended to `dispatchAgentStep` **and** to `dispatchResidentBatch`'s per-generation loop, both under the same null-check | Residency excludes sync today, so the resident arm is dead code — deliberately added so that widening residency to sync inherits the correct semantics instead of silently reintroducing the race. It is a no-op (null pipeline) for every currently-eligible model, so the resident path is unchanged. |
| Attribute run ORDER | The write block is appended AFTER the whole read block (not interleaved per attribute) | Makes both blocks contiguous, so the commit is one linear copy with two baked literals instead of one dispatch (or one loop) per attribute. Pinned by a Tier E assertion. |
| `updateAttribute`'s source | Reads the WRITE run | Matches JS (`w_<attr>[idx]`) and WASM (`syncAttrs ? attrWriteOffset : attrOffset`) exactly, so a preceding Set Attribute in the same step is what an Update sees. Aliased ⇒ identical in async. |
| `Life on Bonds` target | Flipped to **`webgpu`**, and the `.gcaproj` was edited **surgically** rather than regenerated | The library policy is "WebGPU wherever the gate accepts"; P1's only reason to deviate is gone. Re-running the generator mints fresh node ids (a documented churn), so the two changed fields were patched in place — the graph is byte-unchanged apart from them. The generator carries the same change so a future re-run agrees. |

### Assumptions that proved FALSE

**None.** All three §5 assumptions held:

1. **`agentAttrBase` was the only attribute run**, used for both reads and writes — confirmed at
   `layout.ts:260` and 9 emit sites in `compile.ts` (the handoff said ~8; the ninth is `createAgent`'s
   newborn attribute-default writes, which is a write and is routed with the others).
2. **Sync models are excluded from GPU residency** — `agentResidentEligible` requires
   `cfg.agentUpdateMode !== 'sync'` (sim.worker.ts:2300), confirmed at runtime too
   (`residentEligible: false` for the sync model, `true` for Boids / Particle Life).
3. **The bug reproduced before any change** — see the table above.

### Verification

| Gate | Result |
|---|---|
| tsc / build | ✓ `npx tsc -p tsconfig.app.json --noEmit` clean · `npm run build` clean (42 precache entries) |
| parity-agent-wasm | ✓ ALL AGENT SAMPLES: JS↔WASM BIT-PARITY (all entries + every synthetic) |
| check-agent-wasm-gate | ✓ every sample `GATE✓ COMPILE✓ INST✓` |
| audit-agent-layout / test-agent-abi | ✓ 156 checks, all 4 CPU sites in lockstep · ✓ 28 ABI tests |
| check-compile-identity | ✓ vs `.gra-baseline/compile-identity-P2.json` — **26 models, exactly 2 diffs**, both `agent.webgpu.shader` and both on the two SYNC models. Every async agent model's shader hash is unchanged. |
| verify-graph-rewrite | ✓ **106 passed, 0 failed** (88 → 106; the new **Tier E**) |
| Others | ✓ parity-agent-force (7) · verify-agent-render · verify-render-uniform-layouts · audit-modelattr-layout (18) · test-agent-capabilities (75) · test-cross-agent-writes |
| **Async byte-identity (literal diff)** | ✓ **Boids** (no agent attrs) and **Particle Life** (one agent attr): the emitted WGSL before/after is **byte-identical — zero shader lines differ** (the only diff is in my own dump header), and `f32Len` is unchanged (12600 / 70400). The sync `Game of Life on Agents` shader differs by **exactly one line**: the write moved `agentF32[21840u + idx]` → `agentF32[22880u + idx]` while both its reads stay at 21840. |
| **Real GPU / in-browser** | see below |

**Real in-browser run** (dev server, real worker driven through `window.__simWorker`, real GPU;
**0 console errors and 0 worker errors across every session**):

- **The primary gate**: `Game of Life on Agents`, shipped, `agentTarget: 'webgpu'`, sync —
  **0 of 1024 wrong on 3 consecutive trials**, with `alive1` stable at **359**, the exact JS/WASM
  value (before: 123/56/32/32 wrong, alive1 drifting 330–355).
- **Deeper**: exact against the Conway reference over **50, 20 and 100 generations from three
  different seeds** (0/1024 each), boards genuinely evolving (286→152, 298→190, 331→58).
- **O7 ON THE GPU**: `Life on Bonds` (patched to webgpu) and `Game of Life on Agents` seeded
  identically (`seedBoardsMatch: 0`), stepped 61 vs 60 generations (the documented one-generation
  auto-bond bootstrap offset) — **`O7_differential_wrong: 0`**, both at 150 alive. Both resolved
  `agentTarget: 'webgpu'`.
- **Stronger than the differential**: `Life on Bonds` alone vs the independent Conway reference over
  40 generations — **0 of 1024**, 3 trials, on the SHIPPED (unpatched) file, which resolves to
  `webgpu` with the runtime ready.
- **Async unregressed on the GPU**: **Boids** flocks 0 → **polarization 0.9983** over 400 gens;
  **Particle Life**'s `species` histogram is bit-unchanged over 200 gens (324/291/314/270/294/307)
  with agents moving. Both report `residentEligible: true`, so the resident batch — with the new
  conditional commit pass in its loop — ran.

**Tier E negative controls** (a harness that only ever passes proves nothing):
1. Compiling the SAME sync model against a deliberately **aliased (pre-PX) layout** → the
   disjointness check CATCHES that the run is both read and written.
2. **Mutation**: reverting the `setAttribute` emit to the read run made Tier E fail with exactly
   `SYNC shader: NOTHING writes the read run … writes=21840` (then restored, re-run green).

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| I1 handshake | **YES** | `verify-graph-rewrite` Tier A + Tier C unchanged and green (106 checks). PX touches no bond path. |
| I2 symmetry | **YES** | Tier D (the 500-generation compaction audit + both negative controls) green. |
| I3 no dangling | **YES** | Tier A + C green. |
| I4 capacity | **YES** | Tier A + C green. |
| I5 atomicity | *n/a* | PX raises no structural requests; the request buffers are untouched. |

### Known gaps / follow-ups for the next phase

1. **P3 (bond attributes on WebGPU) should inherit this pattern.** The GPU bond store
   (`bondStore`, binding 11) is currently **read-only** and carries `[partnerId, restLengthBits]`
   only. When P3 adds per-edge attribute regions it must answer the same question PX did, and the
   answer is the same shape: **if a rule can read a bond attribute written by ANOTHER agent in the
   same dispatch, the sync path needs a distinct write region + a commit pass.** Concretely:
   `bondAttrWriteBase` alongside `bondAttrBase`, aliased when async; one accessor
   (`bondAttrAt(ctx, attr, slot, 'read'|'write')`) so read/write can never drift; and the commit
   folded into the SAME `attrCommit` pass if the bond-attribute regions are laid out contiguously
   (extend the two baked literals to cover both blocks — cheapest), or a second pass if not.
   ⚠️ **Bond attributes are symmetric — the same value at both ends** — so a Set writes TWO slots
   in different agents' rows; under sync BOTH writes go to the write region and the partner's read
   still sees the previous generation, which is the correct simultaneous-update semantics.
2. **P2's model-level gate term still blocks P3**: `isAgentGraphWebGPUSupported` rejects on
   `bondAttrsOf(model).length > 0` at the top, plus a Properties hint arm keyed on
   `model.bondAttributes?.length` — both must be lifted together (unchanged by PX).
3. **Residency is still async-only** (kept deliberately, per §3.3). Widening it to sync is a
   separate decision; the commit pass is already wired into the resident loop, so the shader side is
   ready — what is NOT done is the rest of `agentResidentEligible`'s reasoning (the CPU no longer
   re-uploads per generation there, so the write-run prime would have to move GPU-side, e.g. the
   commit pass would need a `read → write` prime half at the top of each generation).
4. **Verification trap worth keeping**: the service worker runtime-caches model `.gcaproj`
   (StaleWhileRevalidate), so a browser probe that `fetch`es a model file you just edited on disk
   silently gets the PRE-EDIT copy — the first `Life on Bonds` run reported `agentTarget: 'wasm'`
   purely from that cache. Use `fetch(url + '?t=' + Date.now(), { cache: 'reload' })`.

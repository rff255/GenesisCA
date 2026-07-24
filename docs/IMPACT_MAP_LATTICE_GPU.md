# IMPACT MAP — Lattice GPU Render & Residency

Companion to [PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md) (the measurements)
and [PLAN_LATTICE_GPU.md](PLAN_LATTICE_GPU.md) (the phased plan). This is the
project's mandatory **subsystem-by-subsystem** impact analysis: what each phase
touches, what can break, and the **feature-preservation matrix** every phase
must satisfy.

**The governing rule** (inherited verbatim from the agent arc, and it is what
made that arc safe): *a feature may cost a readback while it is actively used;
it may never lose function.* The sanctioned mechanism is the **readback policy**
— `free` mode (no CPU copy, GPU is authoritative) / `frame` mode (CPU copy every
frame) / the **one-shot rule** (a message that reads or mutates CPU state blocks,
pulls the GPU state down, and replays) — and it lives in **exactly one place**,
the worker message dispatcher.

**The second governing rule**: every gate keys on **general model properties**
(`dimension`, `gridDepth`, resolved compile target, `topologyMode`,
`hasGlyphs`, `skipIsolatedEmpty.enabled`, boundary treatment, capability/usage
flags computed by the compiler) — **never** on a specific model, rule shape, or
node count.

---

## 0. The subsystem map (what exists today)

```
 Modeler graph ──► compilers ──────────────────────────────► worker ──────────► main thread
                   compile.ts        (JS step/init/OM/IC)     sim.worker.ts      SimulatorView.tsx
                   wasm/compile.ts   (+ wasm/layout.ts)        ├ initGrid          ├ draw() 2D  (blit)
                   webgpu/compile.ts (+ webgpu/layout.ts)      ├ buildNeighborIndices
                                                               ├ runStep / runStepWebGPU        └ draw() 3D  (gl3d.ts)
                                                               ├ runColorPass / runColorPassWebGPU
                                                               ├ finalizeStepWebGPU  ← readback
                                                               ├ computeLinkedIndicators / Spatial
                                                               ├ activeSet.ts (SIE)
                                                               └ sendColors  ← the per-frame ship
                                                     runtimes: webgpuRuntime.ts, sharedGpuDevice.ts,
                                                               agentWebgpuRuntime.ts (agents)
```

Facts established by the review that the plan depends on:

| fact | where | consequence |
|---|---|---|
| the 3D canvas attach is gated `!is3D` | [SimulatorView.tsx](../src/simulator/SimulatorView.tsx) ~:4243 | 3D WebGPU is permanently on the readback path |
| `finalizeStepWebGPU` reads colours whenever `!rt.directRender` | [sim.worker.ts](../src/simulator/engine/sim.worker.ts) `wantColors` | 3D always pays `colorsBytes` per frame |
| the 3D renderer is **WebGL2 on the main thread** | [gl3d.ts](../src/simulator/render/gl3d.ts) | it cannot read a WebGPU buffer; a CPU round trip is structural today |
| `dispatchStep` = one encoder + one submit **per generation** | [webgpuRuntime.ts](../src/simulator/engine/webgpuRuntime.ts) | N gens = N submits; the fence is per batch |
| the sparse (SIE) inline-neighbour mode is gated on `sparseSteppingEnabled` | [sparseStepping.ts](../src/modeler/vpl/compiler/sparseStepping.ts) | compact NI tables are unreachable without sparse stepping |
| WebGPU ignores SIE entirely | worker `sieActive: -1` arm | the GPU always dispatches `total` cells |
| one worker-owned refcounted `GPUDevice` serves every runtime | [sharedGpuDevice.ts](../src/simulator/engine/sharedGpuDevice.ts) | a new lattice render pipeline shares it for free — **do not** request a second device |
| an async step batch defers **every** incoming message | worker `asyncStepBatchInFlight` | any new async loop MUST set/clear it (the P0 corruption bug) |

---

## 1. Feature-preservation matrix

Every row must still work after every phase. "Cost" is what the feature is
allowed to pay while it is *in use*.

| feature | today (3D WebGPU) | after L1 | allowed cost |
|---|---|---|---|
| voxel display | main-thread WebGL2 from CPU colours | worker WGSL instanced cubes | — |
| orbit / pan / zoom / auto-orbit / auto-zoom | main thread, gl3d camera | camera uniform posted to the worker (the Phase C `setAgentCamera` precedent) | one uniform upload per camera change (rAF-coalesced) |
| clip interval, cell gaps, background colour, alpha blend | gl3d uniforms | mirrored in the WGSL pass **or** frame mode | — |
| lighting (ball, ambient/diffuse/specular, **shadows**, **occlusion AO**) | gl3d, incl. a shadow-map pass and a CPU AO scan in `uploadColors` | see §3 — the honest scope boundary | frame mode |
| brush plane, footprint outline, hover cube, inspect highlight | gl3d overlay passes | gl3d keeps drawing overlays over a transparent clear (Phase C `setOverlaysOnly`) | — |
| picking (`pick()` colour-id FBO) — brush, inspect, sweep | main-thread FBO pass over the CPU instance buffer | **frame mode** (UI-sync ON while the pointer is over the canvas / a popover is pinned) | one readback while interacting |
| paint / writeRegion / clearRegion / importImage / reset | worker mutation handlers on CPU `readAttrs` + `patchWebGPUCells` | unchanged; the one-shot rule guarantees freshness | one readback per mutation burst |
| cell inspector (per-cell attribute + RGB readout) | `inspectCellIdxs` forces `needAttrs` | unchanged (already a documented readback trigger) | readback while a popover is open |
| screenshot / recording | `gl3dRef.readPixels()` on the display canvas | **frame mode** while recording (already how the agent path works) | full readback while recording |
| linked + spatial indicators | GPU reduction where eligible, else attr readback | unchanged | selective attr readback |
| Overseer experiments | drives the worker via `reqId`-correlated `step`/`reset` | unchanged — it never reads colours | — |
| save `.gcastate` / `getState` | `ensureCpuAttrsFresh` | unchanged | one-shot readback |
| Stop Events / end conditions | per-gen or per-K stop-flag readback | unchanged | — |
| 2D models, agent models, JS/WASM targets | — | **untouched** (all phases gate on 3D + WebGPU or are additive) | — |

---

## 2. Per-phase subsystem impact

### L1 — worker-side WGSL voxel render (3D grids)

| subsystem | impact | risk |
|---|---|---|
| **compilers** (JS / WASM / WebGPU, cell + agent) | **NONE.** The render reads `colorsBuf`, which every target already writes. | — |
| `webgpuRuntime.ts` | **+** a voxel render pipeline (instanced cubes), a depth texture, a camera/lighting uniform, a `presentVoxels` entry. Mirrors `setupDirectRender`. | medium — new GPU state on the shared device |
| `sim.worker.ts` | **+** an `attachVoxelCanvas` message + a `setGridCamera` message + the free/frame policy for the GRID (today only agents have one). `finalizeStepWebGPU`'s `wantColors` gains a "voxel render owns the display" arm, exactly like `rt.directRender`. | **high** — the one-shot rule must extend to grid colours/attrs, and the message dispatcher is the single place |
| `SimulatorView.tsx` | the `!is3D` attach gate becomes a positive 3D gate; a sibling canvas under the gl3d canvas (Phase C layering); `gl3d.setOverlaysOnly()` in free mode; camera posting | medium |
| `gl3d.ts` | **+** nothing structural — it already has `setOverlaysOnly` from Phase C. Frame mode is today's code path verbatim. | low |
| save/load, indicators, Overseer, brush, inspect | unchanged in code; they flip the policy to frame/one-shot | low if the one-shot rule is honoured |
| **2D** | untouched (gate is `is3D`) | — |
| **JS/WASM 3D** | untouched (gate requires the WebGPU target) — they keep the readback path, which is intrinsic for them | — |

**Byte-identity discipline**: L1 touches no compiler file, so
`check-compile-identity` must report **all models unchanged**. If it doesn't,
something is wrong.

### L2 — pipelined step batches

| subsystem | impact | risk |
|---|---|---|
| `sim.worker.ts` step-batch loop (WebGPU arm) | allow ≤ N batches in flight instead of fencing every batch | **highest risk in the plan** — this is the exact shape of the P0 agent corruption bug (concurrent async batches). The `asyncStepBatchInFlight` deferral must remain the invariant: *messages are still deferred*, only the GPU fence is relaxed. |
| `webgpuRuntime.ts` | optionally: record K generations into one encoder (needs `enc.clearBuffer` for the stop flag + a GPU-side per-gen indicator reset, or a gate excluding those) | medium |
| everything else | unchanged | — |

**Gate (general)**: WebGPU grid target + (no per-generation standalone indicator
resets) + (no stop events **or** batch ≤ `webgpuStopCheckInterval`). Glyph
clears fold into an encoder (`enc.clearBuffer`); `queue.writeBuffer`-based
per-gen resets do not, and are the reason for the indicator term.

### L3 — sparse stepping on WebGPU

| subsystem | impact | risk |
|---|---|---|
| `webgpu/compile.ts` + `webgpu/layout.ts` | the step entry reads its cell index from an **active list** instead of `idx`; the layout gains the list + counters | **compiler change → `check-compile-identity` baseline discipline is mandatory**; must be byte-identical when SIE is off |
| `webgpuRuntime.ts` | + active-set maintenance passes (clear → count → scan → scatter) and an **indirect dispatch** | medium — the algorithm is the shipped agent resident-hash build |
| `sim.worker.ts` | `sieActive` stops being `-1` on WebGPU; reset/paint/load must rebuild the GPU active set | medium |
| `activeSet.ts` | unchanged (it stays the CPU source of truth for JS/WASM) | — |
| JS/WASM | untouched | — |

### L4 — inline neighbours on the CPU targets (decouple from SIE)

| subsystem | impact | risk |
|---|---|---|
| `wasm/layout.ts` | the compact packed-NI region becomes reachable without `sparseStepping` | **layout change — the worker's mirror predicate must move in lockstep or every baked offset desyncs** (the documented `+64-cell` corruption class) |
| `compile.ts` (JS) + `wasm/compile.ts` | `ctx.inlineNbr` / `pushInlineNbrCellIdx` become selectable independently of the sparse loop | compiler change → identity baseline |
| `sim.worker.ts` `buildNeighborIndices` | the sparse branch becomes the general branch under the new gate | medium |
| aggregate **fusion** (JS) | already disabled in sparse mode because the fused builders read the per-cell table — the same must hold under the new gate | **this is the step-time risk**: unfused gathers may be slower than the table fetch for some models |
| WebGPU | untouched (already inline) | — |

**This phase must not be committed on faith.** Its whole value rests on an
unmeasured question — is inline decode faster or slower than a table fetch on
the CPU? — so the handoff starts with a throwaway A/B and *stops* if inline
loses on the representative models.

### L5 — `instData` sized by visible cells

| subsystem | impact | risk |
|---|---|---|
| `gl3d.ts` `uploadColors` | grow-on-demand instead of `total × 5` up front | low — local, no ABI |
| everything else | none | — |

### L6 — widen the WebGPU indicator reduction plan

| subsystem | impact | risk |
|---|---|---|
| `webgpuReduce.ts` | + float `total` (f32 bitcast CAS loop) and integer `frequency` (bounded-cardinality slots) | medium — CAS loops and an unbounded-cardinality guard |
| `sim.worker.ts` `finalizeStepWebGPU` | fewer attrs in `watchedAttrIds` | low |
| CPU targets | untouched | — |

---

## 3. Risks, ranked

1. **The one-shot rule leaking (L1).** If any consumer can observe stale grid
   state in free mode, the whole design is unsound. Mitigation: extend the
   *existing* single dispatcher gate (`agentStoreStale` → also `gridStoreStale`),
   never add a second staleness mechanism, and add a hostile probe to the
   verification checklist (`getState` / `paint` / `setInspectCells` fired
   mid-free-run must all reflect post-readback state).
2. **Concurrent async batches (L2).** The exact P0 bug that corrupted the agent
   dynamics with zero errors. Mitigation: keep the message deferral absolutely
   unchanged; only the GPU fence relaxes; add the documented
   overlapped-burst reproducer to the checklist.
3. **Layout/ABI desync (L3, L4).** The `+64-cell` corruption class: the worker
   builds one layout while the compiled module baked another. Mitigation: one
   predicate module consumed by compiler + layout + worker (the
   `sparseSteppingEnabled` pattern), plus a shipped layout signature the worker
   asserts before instantiating (the `agentWasmLayoutSig` precedent).
4. **Visual regression in 3D (L1).** Lighting/shadow/AO parity between a WGSL
   pass and the WebGL2 renderer is not automatable. Mitigation: **the scope
   boundary is explicit** — free mode ships the *core* look (flat/diffuse +
   specular + clip + gaps + background + alpha); shadows and occlusion AO stay
   **frame-mode features** (documented, gated, and the toggle detaches free mode
   exactly like 3D alpha-blend does today). A user eyeball in a **visible pane**
   is a required sign-off, not an optional one.
5. **Measuring in an occluded pane (all phases).** Composited pixels, rAF and
   possibly GPU-process scheduling are unreliable while `document.hidden`.
   Mitigation: every phase's checklist separates *protocol-provable* claims
   (worker messages, buffer readbacks, `getCompilationInfo`) from *pixel* claims
   (deferred to an orchestrator/user spot-check in a visible pane), and L2 must
   re-measure its target number visibly **before** implementing.
6. **Device pressure (L1 + L3).** New pipelines and a depth texture on the
   shared device. Mitigation: acquire through `sharedGpuDevice.ts`, release on
   every teardown path, and keep the adapter-request counter at 1 across
   rebuilds (the E1 probe).

---

## 4. Non-goals (explicit)

- No change to any **rule semantics**, node catalogue, schema, or `.gcaproj`
  format. Nothing in this plan is user-authored state.
- No **model-specific** gate, threshold tuned to a shipped model, or "fast path
  for GoL". Every gate is a general property.
- No **second GPU device**, no COOP/COEP / `SharedArrayBuffer`, no server.
- No **precision policy change** (f64 stays f64 on JS/WASM; WGSL stays f32).
- The **fundamentals stay fundamentals**: asynchronous update mode on WebGPU and
  order-dependent indicator ops (`toggle`/`next`/`previous`) are genuine
  execution-model incompatibilities, not scoping limits (§5).
- No attempt to make the **JS/WASM 3D** path avoid its colours readback — it is
  a CPU renderer reading CPU colours; that round trip is intrinsic, and L5 is
  the only honest improvement available there.

---

## 5. Fundamentals vs scoping limits (audited)

A **fundamental** is a property the execution model genuinely cannot express.
Everything else is scope, and scope is allowed to be lifted later.

| restriction | verdict | why |
|---|---|---|
| asynchronous update mode on WebGPU | **FUNDAMENTAL** | a write must be visible to a later cell *within the same step*; a parallel dispatch has no such ordering |
| `updateIndicator` toggle / next / previous on WebGPU | **FUNDAMENTAL** | non-commutative mutation of one shared accumulator by parallel writers |
| SIE requires synchronous mode | **FUNDAMENTAL** | the async shuffled single-buffer order is incompatible with list iteration |
| SIE excludes agent models | **FUNDAMENTAL (as specified)** | agents deposit into cell attributes *outside* the step, so the active set cannot observe those transitions |
| SIE excludes glyph models | **SCOPING** | the per-pass glyph zero-fill assumes a full repaint; a sparse glyph clear would lift it |
| WebGPU ignores SIE | **SCOPING** → L3 | nothing about a parallel dispatch forbids an active list; it just was not built |
| CPU targets need a full neighbour table | **SCOPING** → L4 | the inline decode exists and is used by the sparse path |
| 3D never gets GPU direct render | **SCOPING** → L1 | the renderer is WebGL2/main-thread; a WGSL voxel pass removes the constraint |
| f32 on WGSL vs f64 on JS/WASM | **DOCUMENTED DIFFERENCE** | intentional, not a defect |
| per-cell PCG vs shared xorshift32 RNG | **DOCUMENTED DIFFERENCE** | intentional; statistical parity only |

No other fundamentals were found in this audit. In particular, neither
**glyphs**, **variegated cells**, **lookup tables**, **sub-attributes**,
**spatial indicators**, nor **Stop Events** are fundamentals for any phase here
— each is either untouched or costs a readback while used.

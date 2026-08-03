# PLAN — C10 · P11a: deterministic Barnes-Hut GLOBAL charge (all targets)

Phase C10 of the Clarity & Simplification initiative
([HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md) §C10, implementing
[PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md) **P11 item 1**).

**Goal**: "Charge range: **Cutoff** / **Global (Barnes-Hut θ)**" as an explicit FORCE-LAW
option on the Charge capability — deterministic on CPU, delivered on all three agent
targets, and **benchmark-gated**.

The two framings this rests on (proposal §P11):

- **Approximate ≠ nondeterministic.** A CPU Barnes-Hut run in lockstep is fully
  deterministic: same positions → same Morton codes → same order-canonical traversal →
  bit-identical forces, every run. Seeded, replayable, Overseer-sweepable.
- **θ changes WHICH law you run, not repeatability.** The shipped cutoff law
  (`k·(1/(1+d²) − 1/(1+max²))` with a hand-picked cutoff) is already an aesthetic modelling
  choice; "this model's force law is the θ = 0.9 tree charge" is exactly as legitimate.

---

## 0. IMPACT MAP (written first, per the house rule)

### 0.1 What global charge actually is, mechanically

The shipped L1 charge is a **pair** force evaluated inside the neighbour scan, so its reach
is bounded twice: by `chargeMaxDist` (the law's own cutoff) **and** by the spatial-hash bin
edge (which `chargeBinEdgeOf` widens to match — "the trap"). Global charge removes the
cutoff entirely (`min_c = 0`, no `d² ≤ maxD²` test) and replaces the pair scan with **one
Barnes-Hut tree traversal per agent**. That is not a speed-up of the same law; it is a
**different law with unbounded reach**, which is the thing a finite-cutoff hash structurally
cannot express.

| | cutoff (shipped) | global (this phase) |
|---|---|---|
| law | `k·(1/(1+d²) − 1/(1+maxD²))·(pⱼ−pᵢ)` for `d ≤ maxD` | `k·(1/(1+d²))·(pⱼ−pᵢ)` for **every** pair, θ-approximated |
| evaluated in | the 3×3(×3) hash stencil | a per-agent octree traversal |
| bin edge | **widened** to `chargeMaxDist` | **not widened** — the stencil carries no charge |
| cost | O(N · candidates-in-9-bins) | O(N log N) |
| `min_c` | `1/(1+maxD²)` (takes the force to zero at the cutoff) | **0** |

### 0.2 Subsystem-by-subsystem

| # | Subsystem | Impact |
|---|---|---|
| 1 | **Schema** (`types.ts`) | `CenterBasedConfig.chargeRange?: 'cutoff' \| 'global'` + `chargeTheta?: number`. Both optional; **absent ⇒ `cutoff` ⇒ byte-identical**. No migration (charge itself is net-new since L1 and no shipped model can carry the field). |
| 2 | **Resolvers** (`centerBased.ts`) | `chargeRangeOf` / `chargeThetaOf` (clamped) / `usesGlobalCharge`; `ChargeParams` gains `doChargeTree` + `chargeTheta2`. **`chargeBinEdgeOf` returns 0 in global mode** — the stencil no longer carries charge, so widening it would be pure cost. `chargeParamsOf.doCharge` keeps its exact meaning ("run the cutoff PAIR term"), so every existing consumer is unchanged. |
| 3 | **Engine** (`agentEngine.ts`) | NEW `buildAgentOctree(store, …) → AgentOctree \| null`: Morton codes + an **order-canonical stable radix sort** + node accumulation + skip links. Plain typed arrays, allocated once and reused (the `buildSpatialHash` precedent). NEW layout regions, appended AFTER every existing one and reserved **only** when the model uses global charge (`AgentLayoutExtras.chargeTreeNodes`, 0 ⇒ zero bytes ⇒ every existing layout byte-identical). |
| 4 | **Worker** (`sim.worker.ts`) | Build the tree once per generation (beside the hash) when global charge is on; traverse it in BOTH JS force arms (2D + 3D); copy it into the WASM memory regions (the AW-HASH copy precedent); upload it to the GPU. `doScan` unchanged in shape — global charge simply does not join it. |
| 5 | **WASM** (`agentWasm/compile.ts`) | `emitForcePass` gains a compile-time `chargeGlobal` variant: it emits the **tree traversal instead of** the pair term. Two appended params (`treeNodeCount : i32`, `chargeTheta2 : f64`) under the existing **conditional-arity contract** — 26 (charge off) / 30 (cutoff) / 32 (global). |
| 6 | **WebGPU** (`agentWebgpu/forcePass.ts`, `agentWebgpuRuntime.ts`) | CPU-built tree uploaded per generation into two new storage bindings (**7** f32, **8** i32), gated on a `usesChargeGlobal` usage flag (the Naga stripped-binding discipline). The traversal is emitted by **one shared helper** used by BOTH the canonical and the B1 mirror bodies — the same rule `chargeTerm` already follows. `ForceControl` gains 3 fields; `FORCE_CONTROL_BYTES` 128 → 144; the uniform-layout registry entry covers it. |
| 7 | **Residency** (`agentResidency.ts`, worker) | Global charge is a **new residency blocker** (Class F): the tree is CPU-built per generation, and a resident batch has no CPU touch point between generations. Surfaces in C1's readout and C3's diagnostics. GPU tree BUILD is a recorded follow-up. |
| 8 | **C2 pipeline** (`generationPipeline.ts`) | The `agent.charge` phase reports the mode (`global (Barnes-Hut θ = …)` vs the cutoff), and the hash-build phase stops claiming a charge-widened bin edge under global. |
| 9 | **UI** (`AgentCapabilitiesSection.tsx`) | Two rows inside the existing Charge block: a **Range** select (Cutoff / Global) and, under Global, **θ**. The cutoff field is hidden under Global (it means nothing there) — following the `hiddenPorts` doctrine of never showing an inert control. |
| 10 | **Harnesses** | `parity-agent-force` gains global combos (2D+3D × θ × collision on/off) + an arity assertion for the 32-param module; `audit-agent-layout` learns the tree regions; `verify-render-uniform-layouts` covers the widened `ForceControl`; `probe-graph-layout` gains **the benchmark gate**. |

### 0.3 The seam decision (the runbook asks for it to be justified)

> **Build the tree in TypeScript in the engine; traverse it on each target.**

Two candidate seams:

- **(A) Engine-TS build + per-target traversal** — the tree is built once in `agentEngine.ts`
  into plain typed arrays; the WASM path copies them into reserved agent-memory regions and
  traverses at baked offsets; the GPU path uploads them.
- **(B) Emitted build** — each target compiles its own tree builder.

**(A) is chosen**, for a reason that is specifically about *parity risk*: the BUILD is where
two implementations drift (a bbox reduction, a float→int quantization, a sort's tie-break,
a recursive split order), and it runs **once per generation**, not once per pair. The
TRAVERSAL is the hot part and is pure arithmetic over shared bytes — exactly the shape the
existing force pass already keeps bit-identical across JS and WASM. So (A) puts the single
implementation where the risk is and the mirrored implementation where it is cheap. It is
also precisely the **`buildSpatialHash` precedent**: built in TS, copied into WASM memory,
dims passed as call args, uploaded to the GPU as a buffer. (B) would triple the surface that
must agree on Morton quantization for zero measured benefit.

### 0.4 Determinism — the four things that make it hold

1. **Morton quantization is a pure function of the positions** (bbox → extent → a 1023-scale
   integer per axis). Same positions ⇒ same codes.
2. **The sort is ORDER-CANONICAL**: ties in the Morton code are broken by the agent's
   canonical index, so the resulting permutation is a *total* order — independent of the
   sorting algorithm. Implemented as a **stable LSD radix sort** (3 × 10-bit passes) seeded
   from an index-ordered array, which realises exactly `(morton, index)` order and is
   deterministic by construction (no comparator, no library sort).
3. **The build is a deterministic DFS** over octant counts, with a **node-count cap** that
   degrades a node to a LEAF when the reserve is exhausted. A leaf is *more* exact (it does
   the per-point sum), so the cap can never make the result wrong — only slower — and it
   bites at exactly the same place every run.
4. **The traversal is a fixed-order walk** (`nodeI` ascending with skip links, leaf points in
   sorted order), so the f64 accumulation order is identical on JS and WASM.

### 0.5 Known, documented properties of the law (not defects)

- **Self-interaction is not excluded.** A node containing the agent itself can pass the θ
  criterion (the centre of mass can sit up to ≈ `extent·√3` away from a contained point), in
  which case the agent feels the node's whole mass including its own 1/N share. This is the
  reference behaviour (znah's `calcMultibodyForce` does the same) and it is bounded by θ.
  Leaf-level self-interaction is *exactly* zero (`d = 0 ⇒ c·d = 0`), so the error is confined
  to the far-field approximation — which is what θ names.
- **The tree is 3D-native.** A 2D model is `z = 0` for every agent, so the octree degenerates
  to a quadtree with a constant z bit-plane. One code path, no 2D special case in the build.
- **f32 on WebGPU** — statistical equivalence, exactly as the target already offers.

### 0.6 What must stay byte-identical

Every model with `chargeRange` absent or `'cutoff'` — i.e. **all 29 shipped models**. The
mechanisms: the layout regions reserve **0 bytes** unless global charge is on; the WASM param
list is unchanged for 26/30-param modules; the WGSL emits the tree helper only under the
usage flag; and `chargeParamsOf`'s existing four fields keep their exact values.

---

## 1. The benchmark gate (this decides whether the UI ships enabled)

L1 measured that layout quality **saturates around an 8× bond-rest cutoff** and that an
unbounded cutoff merely *inflates* the layout — which is why L1 shipped a plain cutoff and
explicitly recorded "no Barnes-Hut tree is needed". C10 must confront that finding with
numbers rather than assume the tree wins.

`scripts/probe-graph-layout.mjs` gains a **global-vs-cutoff** section on the grown-GRA blob
at N ≈ 2.5k / 5k / 20k, reporting for each: `nnb/bond`, `overlap%`, and **ms/gen**.

**Decision rule** (stated before the numbers were taken):

- Global measurably improves the unfolding metrics within a sane per-generation budget
  ⇒ ship the UI rows enabled.
- Global does **not** improve them ⇒ **keep the code behind the config, do not advertise it
  in the UI as a recommended path**, and document the measurement honestly. Benchmark-gated
  means gated.

Either way the code ships (it is the P11 force-law *option*), fully verified and harnessed;
the gate decides how prominently it is offered.

---

## 2. Verification plan

| Gate | What it proves |
|---|---|
| `tsc -p tsconfig.app.json --noEmit` + `npm run build` | compiles |
| `check-compile-identity --compare` | cutoff/off models byte-identical; every moved surface enumerated |
| `parity-agent-force` (extended) | JS↔WASM **bit-parity** for global charge, 2D+3D × θ × collision on/off; the 32-param arity contract |
| `audit-agent-layout` (extended) | the tree regions are laid out consistently at every mirror |
| `verify-render-uniform-layouts` | the widened `ForceControl` writer ⇄ its WGSL struct |
| `probe-graph-layout` (extended) | THE BENCHMARK; plus the existing L1 gates still pass |
| real GPU, in-browser | both force shaders compile 0 errors; a fixture's GPU forces match the CPU within f32 tolerance |
| `parity-agent-wasm`, `check-agent-wasm-gate`, `test-c9-gates`, `test-generation-pipeline`, `test-agent-capabilities`, … | no regression |

---

*Completion evidence — including the full benchmark table and the compile-identity
enumeration — lives in the §C10 Completion Report in the runbook.*

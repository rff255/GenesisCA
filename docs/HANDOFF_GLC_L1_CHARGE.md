# PHASE L1 — The charge force (long-range repulsion with a finite cutoff)

**Read first**: [HANDOFF_GRAPH_LAYOUT_CADENCE.md](HANDOFF_GRAPH_LAYOUT_CADENCE.md)
§0 (invariants), **§0b (measured traps — these WILL bite you if you skip them)**,
§3 (verification recipes). Design authority:
[IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md](IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md) §1, §2, §5.

**State**: READY · **Depends on**: nothing · **Blocks**: L3

---

## 1. The problem, measured

The agent pair law gives **repulsion only below contact distance** (1.8 units for the
shipped `Cubic GRA`), **attraction** from there to `interactionRange × contact`
(3.96), and **nothing beyond** — while **bonds rest at 5**. A node pushes back only
once something is on top of it, so a growing graph collapses to a jammed packing.

Measured on K4 → 1200 nodes by triangle split through the real force loop:

| | nnb ÷ bond | overlap |
|---|---|---|
| shipped | **0.06** | **99.2 %** |
| +30× settle time | 0.06 | 99.4 % |
| **+ widened `interactionRange`** | **0.06** | **99.4 %** |
| **+ charge** | **0.81** | **0.0 %** |

> ⚠️ Row 3 is why **this is not a tuning task**. `interactionRange` widens the
> *search*, not the force.

**And a finite cutoff suffices** — quality saturates by ~8× the bond rest length;
unbounded range only inflates the layout. **So: no Barnes–Hut, no octree, no new
spatial structure.** (Decision DC1.)

---

## 2. Scope — what you build

### 2.1 The law

```
f_ij = chargeStrength · ( 1/(1 + d²) − 1/(1 + maxDist²) ) · (p_j − p_i)
```

`chargeStrength < 0` ⇒ repulsive. The `− min_c` term takes the force continuously to
zero at the cutoff rather than stepping. Applied to **every pair within
`chargeMaxDist`**, in addition to soft-sphere and bond springs. Same law, same cutoff,
**same fused pass, on all three targets** — no per-target algorithm (DC2).

### 2.2 Config + capability

- `AgentCapabilities.charge: 'off' | 'on'` — **default `off`**;
  `computeCapabilityClosure` requires `motion: 'force'`.
- `CenterBasedConfig.chargeStrength` (default ≈ −3) and `chargeMaxDist`
  (**default ≈ 8 × the model's bond rest length**, DC6 — expose it, don't hard-code a
  world-absolute number).
- A `usesCharge(cfg)` resolver in `centerBased.ts`, mirroring `usesSoftCollision` —
  including its legacy-fallback discipline so an absent capability reproduces today.
- Properties → Bond-Graph Agents: a Charge block, revealed when the capability is on.

### 2.3 The four force surfaces — ALL of them

| surface | where | note |
|---|---|---|
| JS | `sim.worker.ts` `runAgentStep` | **SEPARATE verbatim 2D and 3D arms — both** |
| WASM | `agentWasm/compile.ts` `emitForcePass` | `FORCE_PASS_PARAMS` — **append at the END** |
| WebGPU | `agentWebgpu/forcePass.ts` | `ForceControl` gains fields — register/verify the uniform layout |
| **B1 mirror** | the bin-sorted mirror force pipeline | **easy to miss ⇒ silent divergence** |

### 2.4 THE trap — the hash bin edge

`binEdge = max(range * 2 * maxR, neighbourQueryRadius)`.

**`chargeMaxDist` must join that `max`.** If it does not, the 3×3(×3) stencil does not
cover the charge radius and the force is **silently truncated** — the model looks
plausible and the physics is wrong. This is the single easiest way to get this feature
subtly wrong, and it has its own exit-gate test (§4).

### 2.5 Cost

At cutoff = 8 × rest with a healthy layout, expect **~250 neighbours/agent in 2D**
(≈1.3 M pair-ops at N = 5000 — a few ms). **3D is much worse — the stencil is a
volume.** Measure it, report it, and document a practical 3D cutoff. Do not assume the
2D default transfers.

---

## 3. What this phase must NOT do

- **No Barnes–Hut / octree / Morton sort** (DC1 — measured unnecessary).
- **No cadence work** (L2), **no sample retuning** (L3), **no `layoutIterations`** (L3).
- **No change to the existing soft-sphere or spring terms** — charge is additive.

---

## 4. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **THE fix, measured** | `probe-graph-layout.mjs`: overlap **99.2 % → ≤ 1 %**, nnb ÷ bond **0.06 → ≥ 0.6**. Extend the probe to drive the **REAL engine charge term** (not its local copy) so it tests shipped code. |
| **The bin-edge trap** | two agents at **0.9 × `chargeMaxDist`**, unbonded ⇒ a **non-zero** charge force. Negative-control it: revert the `binEdge` change and watch this test fail. |
| **The B1 mirror** | the mirror force variant and the canonical one agree **with charge on** |
| **Byte identity** | charge **off** ⇒ `check-compile-identity --compare .gra-baseline/compile-identity-L0.json` unchanged on every surface |
| **JS↔WASM bit-parity** | `parity-agent-force.mjs` with **new charge combos**: charge on/off × 2D/3D × torus/bounded × collision on/off |
| **3D** | works, measured, with the cost and a practical cutoff documented |
| **Real GPU** | 2D and 3D shaders compile 0 errors / 0 validation errors; a real in-browser run, 0 worker/GPU errors |
| Standard | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` · `verify-render-uniform-layouts` |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **The fused pair loop is the only place pair forces are summed** on each target —
   i.e. adding a term there reaches every path. If a fourth force site exists beyond
   the four in §2.3, **stop and report**; the divergence risk changes.
2. **`binEdge` is computed in one place per target** and widening it is safe for the
   hash reserve (`computeAgentMaxHashBins` caps the bin count — a larger edge means
   *fewer* bins, so the reserve should be safe, but **verify**, because an overflow
   silently falls back to all-pairs or to JS).
3. **`FORCE_PASS_PARAMS` can be extended by appending** without shifting any baked
   offset (P5's finding was about mid-list insertion).
4. **`ForceControl` has room** for two more scalars without breaking the registered
   uniform layout, and `verify-render-uniform-layouts.mjs` covers it.

---

## Completion Report — L1

**State**: DONE
**Commit(s)**: `226b5de` — feat(agents): long-range charge force with a finite cutoff
**Files touched**
```
 CLAUDE.md                                              | docs
 README.md                                              | docs
 docs/HANDOFF_GLC_L1_CHARGE.md                          | this report
 docs/HANDOFF_GRAPH_LAYOUT_CADENCE.md                   | status board
 scripts/parity-agent-force.mjs                         | +11 charge combos, arity contract, bin-edge trap
 scripts/probe-graph-layout.mjs                         | rewired onto the REAL engine + gate + 3D cost
 scripts/verify-render-uniform-layouts.mjs              | ForceControl registered (+ structFile)
 src/help/HelpView.tsx                                  | docs
 src/model/agentCapabilities.ts                         | charge capability + closure + row
 src/model/centerBased.ts                               | usesCharge / chargeParamsOf / chargeBinEdgeOf …
 src/model/types.ts                                     | ChargeMode + config fields
 src/modeler/panels/AgentCapabilitiesSection.tsx        | Charge block
 src/modeler/vpl/compiler/agentWasm/compile.ts          | conditional params + charge emit
 src/modeler/vpl/compiler/agentWebgpu/forcePass.ts      | charge in BOTH bodies + ForceControl
 src/simulator/engine/agentWebgpuRuntime.ts             | uniform writer + resident bin edge
 src/simulator/engine/sim.worker.ts                     | JS 2D+3D arms + all 3 hash sites + dispatch
```

### What shipped
The long-range charge force, default OFF, on **all four force surfaces**:
`f_ij = k·(1/(1+d²) − 1/(1+maxDist²))·(p_j − p_i)` for every pair within
`chargeMaxDist`, evaluated **before** the soft-sphere's own much smaller `rmax`
cutoff rejects the candidate (riding inside it would clip charge to the contact
radius). **No Barnes–Hut, no octree, no new spatial structure** — one extra term in
the fused pair loop each target already had, plus a widened hash bin edge.

- **Capability** `AgentCapabilities.charge: 'off' | 'on'`; closure requires
  `motion: 'force'`, and dropping Motion below Force turns it back off.
- **Config** `chargeStrength` (default −3) + `chargeMaxDist` (**absent ⇒ a derived
  `8 × bondRestLength`**, DC6 — verified live: the shipped `Cubic GRA`, whose
  `chargeMaxDist` is absent, resolves to 40).
- **Resolvers** (`centerBased.ts`): `usesCharge` · `chargeStrengthOf` ·
  `chargeMaxDistOf` · `chargeBinEdgeOf` · `chargeParamsOf`. The last precomputes
  `{doCharge, chargeK, chargeMaxD2, chargeMinC}` in ONE place — like `dtOverEta` —
  so all four surfaces fold identical constants, which is what makes JS↔WASM
  bit-parity hold rather than "happen to agree".
- **THE trap**: `chargeBinEdgeOf` joins the `max` at all three hash sites
  (`runAgentStep`, the per-gen WebGPU path, `computeResidentHashParams`). Positional
  collision deliberately keeps the narrow edge. `computeAgentMaxHashBins` is
  **untouched** — see the assumption note below.
- **Surfaces**: JS (both verbatim arms × stencil + all-pairs = 4 sites), WASM
  `emitForcePass`, the WGSL canonical body, and the **B1 mirror body** (a shared
  `chargeTerm(is3d)` emits both GPU bodies so they cannot drift). Charge also joins
  every scan gate — a pure charged gas has no soft-sphere, springs or density
  consumer, so otherwise the whole neighbour pass would be skipped.

### Decisions resolved (with reasoning)
1. **WASM params are CONDITIONAL; WebGPU gates at RUNTIME.** The WASM param list is
   part of the module's type section, so an unconditional block would change every
   agent model's bytes and break byte-identity — hence `forcePassParamsFor(charge)`
   appends 4 params only when used. The shader text is *not* compile-identity-checked,
   so WGSL always declares the fields and branches on `fc.doCharge`: one shader serves
   both states, toggling charge never rebuilds a pipeline, and the struct stays
   statically parseable (which is what let it be registered in the uniform harness).
2. **The worker always passes all 30 args.** A charge-off module declares 26 and the
   JS API ignores the extras; this makes the *dangerous* direction — a module that
   declares them while the worker omits them, yielding `undefined` ⇒ NaN ⇒ poisoned
   forces — structurally impossible. Asserted rather than assumed.
3. **The probe now drives shipped code.** It previously carried its own copy of the
   force loop plus a hand-written charge term. A probe that measures its own
   reimplementation cannot gate the product, so it now compiles and runs the real
   WASM `forcePass` over a real `createAgentStore`.

### Assumptions that proved FALSE
**#4 was PARTIALLY false — and it did not change the design.**
"`ForceControl` has room for two more scalars … and `verify-render-uniform-layouts.mjs`
covers it."
- *Room*: true (and for four, not two). 25 → 29 scalars; `FORCE_CONTROL_BYTES` 112 → 128.
- *Covered*: **false.** The harness registry explicitly **excluded** ForceControl,
  reasoning that structs "baked into the shader source … cannot drift from a separate
  index table because there isn't one". That is right for the agent `Control` uniform
  (its member set varies with the compiled layout) but **wrong for ForceControl**: a
  fixed hand-written WGSL field list in one file plus a hand-written table of literal
  indices (`u[0]`, `fl[6]`, …) in another is *exactly* the pairing the harness exists
  for — and it is read by BOTH GPU force pipelines.
- **Remedy (additive, no redesign)**: registered it, adding an optional `structFile`
  for the two-file case. §2.3 of this handoff already said "register/verify the uniform
  layout", so this completes the phase's own scope rather than expanding it.
  Negative-controlled: dropping one charge write reports `unwritten: chargeMaxD2@108`.

Assumptions **1, 2 and 3 held**, with two refinements worth recording:
- **#1** — the fused pair loop is indeed the only place pair forces are summed, but it
  is **five code paths, not four**: the JS 2D and 3D arms are separate *and* each has a
  stencil + an all-pairs body, and the WGSL emitter contains two neighbour bodies
  (canonical + mirror). `resolvePositionalCollisions` reuses `forceX/Y` as a *position*
  accumulator, not a force sum, and `forceScatter` is a per-agent seed.
- **#2** — widening the bin edge is safe for the reserve, but the reserve itself must
  **NOT** be widened: `computeAgentMaxHashBins` feeds `computeAgentMemoryLayout`, so
  changing it would shift every baked offset past the hash region. It is computed from
  the *smallest* possible edge and a larger edge yields *fewer* bins, so leaving it
  alone is both safe and byte-identical.

### Verification
| Gate | Result |
|---|---|
| `probe-graph-layout.mjs` (the oracle) | **✓** overlap 99.2 % → **0.2 %**, nnb/bond 0.18 → **0.81**; gate asserts all three conditions |
| Bin-edge trap + negative control | **✓** widened edge feels the charge at 0.9× cutoff; the pre-L1 edge reads **exactly 0** |
| B1 mirror vs canonical, charge on | **✓** real GPU, **maxDiff 0** over 8 agents (vx+vy), 0 validation errors |
| Byte identity (charge off) | **✓** `check-compile-identity --compare .gra-baseline/compile-identity-L0.json` — 29 models, all surfaces unchanged |
| `parity-agent-force.mjs` | **✓ 20 checks** — 11 new charge combos (on/off × 2D/3D × torus/bounded × collision on/off × charge-only), 0 mismatches; + the arity contract |
| 3D | **✓** works (parity + shaders); cost measured, practical cutoff documented |
| Real GPU | **✓** all 8 shader variants (2D/3D × mirror × scatter) compile 0 errors / 0 pipeline / 0 validation; a real dispatch matches the analytic force to **2.2e-8** and is exactly antisymmetric |
| Real in-browser run | **✓** shipped `Cubic GRA`, WASM agent target, 240 generations, **0 worker + 0 console errors**, A/B below |
| `tsc` · `npm run build` | ✓ · ✓ |
| `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` (192) · `test-agent-abi` (28) | ✓ ✓ ✓ ✓ |
| `verify-graph-rewrite` (405) · `verify-agent-render` · `verify-render-uniform-layouts` · `test-agent-capabilities` (80) | ✓ ✓ ✓ ✓ |

**Negative controls** (both proven to fail, then restored): dropping `− chargeMinC`
from the WASM emit → 1500-3000 mismatches on every charge combo; dropping one charge
write from `uploadAgentForceControl` → `unwritten: chargeMaxD2@108`.

### Layout metrics — before → after
**The probe (4000×4000, unsaturated), K4 → 1200 by triangle split, real WASM force pass:**

| scenario | bond/rest | nnb/bond | overlap % | cand/agent |
|---|---|---|---|---|
| **SHIPPED (charge off)** | 1.04 | **0.18** | **99.2** | 8 |
| charge −3, cutoff 20 (4× rest) | 1.29 | 0.66 | 0.0 | 6 |
| **charge −3, cutoff 40 (8× rest) — the default** | 1.52 | **0.81** | **0.2** | 7 |
| charge −3, cutoff 80 (16× rest) | 1.81 | 0.87 | 0.0 | 15 |
| charge −3, cutoff 160 (32× rest) | 2.16 | 0.89 | 0.0 | 99 |

> The baseline nnb/bond reads **0.18**, not the 0.06 in this handoff's §1. That is the
> cost of the probe now driving the REAL engine instead of its own copy: the old copy
> used `interactionRange` as an absolute *distance* (2.2) where the engine uses it as a
> multiplier of contact distance (`2.2 × 1.8 = 3.96`), i.e. it modelled a narrower
> repulsion than the engine actually has. The headline — **99.2 % overlap** — is
> unchanged, and 0.18 is still far below the 0.6 "healthy" line. Trust these numbers
> over the pre-L1 ones; they come from shipped code.

**Live in-browser A/B, shipped `Cubic GRA` (220×220 torus, WASM agents, gen 240):**

| | live | bond | nnb | nnb/bond | overlap % |
|---|---|---|---|---|---|
| charge OFF (shipped) | 4982 | 4.77 | 0.34 | **0.07** | **99.8** |
| charge ON (derived 8× cutoff = 40) | 2278 | 5.74 | 2.68 | **0.47** | **14.3** |

> **The residual 14.3 % is the SECOND, independent cause** the impact map identified
> (§1.4), not a shortfall of the force: at 2278 agents a 220×220 torus gives 4.6
> units/agent against a bond rest of 5, so the world is **saturated** and no repulsion
> strength can open it. In the unsaturated probe world the same force reaches 0.2 %.
> (The two runs also reach different N — a jammed graph satisfies the split predicate
> differently — so read the ratios, not the populations.)

### 3D cost — measured, and the practical cutoff
Uniform packing, spacing = bond rest 5, 1728 agents, real WASM force pass:

| dim | cutoff | cand/agent | ms/tick |
|---|---|---|---|
| 2D | 20 (4×) | 124 | 1.83 |
| 2D | 40 (8×) | 427 | 5.42 |
| **3D** | **20 (4×)** | **813** | **11.83** |
| **3D** | **40 (8×)** | **1728** | **23.83** |

The stencil is a 3×3×3 **volume**, so candidates grow with the CUBE of the cutoff:
3D costs ~6.6× the 2D time at the same cutoff. At 8× rest in 3D the stencil already
covers the entire population (1728 of 1728) — it has degenerated to all-pairs while
buying nothing, since quality already saturates by 8× in 2D and 4× already gives
0.66 nnb/bond. **Guidance shipped in the UI, Help and README: start 3D at ~4× the
bond rest length, not 8×.**

### Known gaps / follow-ups
- **For L3**: the shipped `Cubic GRA` needs a **bigger (or unbounded) world** — charge
  alone cannot open a saturated box (DC7). Its own `bondRestLength` is 5, so the derived
  cutoff of 40 is sane; the world is the binding constraint.
- **For L3**: no sample turns charge on yet — retuning them is explicitly L3's scope.
- The probe's growth process still places newborns by hand; L3 owns newborn placement.
- Barnes–Hut remains deferred (DC1). This implementation is its exactness reference.

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

*(fill in per the master handoff §5 template, and include the probe's
before → after metrics — that is this phase's headline)*
